//! Lock-free file I/O. Every call opens, works, and closes: no handle outlives
//! a command, and every open allows other programs to read, write and delete.

use encoding_rs::CoderResult;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Globalization::GetACP;
use windows_sys::Win32::Storage::FileSystem::{
    ReplaceFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS,
};

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

/// The literal error the frontend matches on.
const STALE: &str = "STALE";

/// Prefix of the error for text the ANSI code page cannot hold.
const UNMAPPABLE: &str = "UNMAPPABLE";

/// Mixed line endings are only kept for files up to this size: keeping them
/// means reading and decoding the old text once more.
const KEEP_EOL_MAX: u64 = 64 * 1024 * 1024;

/// Smallest window that can always hold one whole character plus a CRLF,
/// so a chunk cut always makes progress.
const MIN_WINDOW: u64 = 8;

/// Matches the frontend's first chunk: the most EOL detection ever looks at.
const FIRST_CHUNK: u64 = 256 * 1024;

const STREAM_BUFFER: usize = 64 * 1024;

const BOM_UTF8: &[u8] = &[0xEF, 0xBB, 0xBF];
const BOM_UTF16LE: &[u8] = &[0xFF, 0xFE];
const BOM_UTF16BE: &[u8] = &[0xFE, 0xFF];

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "ansi")]
    Ansi,
}

impl Encoding {
    fn bom(self) -> &'static [u8] {
        match self {
            Encoding::Utf8Bom => BOM_UTF8,
            Encoding::Utf16Le => BOM_UTF16LE,
            Encoding::Utf16Be => BOM_UTF16BE,
            Encoding::Utf8 | Encoding::Ansi => &[],
        }
    }

    fn codec(self) -> &'static encoding_rs::Encoding {
        match self {
            Encoding::Utf8 | Encoding::Utf8Bom => encoding_rs::UTF_8,
            Encoding::Utf16Le => encoding_rs::UTF_16LE,
            Encoding::Utf16Be => encoding_rs::UTF_16BE,
            Encoding::Ansi => ansi_codec(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum Eol {
    Crlf,
    Lf,
    Cr,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub size: u64,
    /// Whole milliseconds, so the value survives the JSON round trip through JS
    /// exactly and stamps can be compared with `==`.
    pub mtime_ms: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub text: String,
    pub next_offset: u64,
    pub eof: bool,
    pub encoding: Encoding,
    pub eol: Eol,
    pub stamp: FileStamp,
    /// This chunk has a line ending other than `eol` (the file's first one), so
    /// the file has mixed line endings (FILES-1). Each chunk reports only its own
    /// text: a frontend that loads several chunks ORs them together.
    pub mixed_eol: bool,
    /// The file has the read-only attribute, or this user may not write to it.
    /// Only checked for the chunk at offset 0; later chunks report false.
    pub read_only: bool,
    /// The chunk holds NUL characters, so it is most likely not text (M15). Saving
    /// it would damage it.
    pub binary: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub path: String,
    pub text: String,
    pub eol: Eol,
    pub encoding: Encoding,
    pub tail_offset: Option<u64>,
    pub expected_stamp: Option<FileStamp>,
    /// Lets characters the ANSI code page lacks become `?`. Without it such a
    /// save fails with UNMAPPABLE and writes nothing.
    #[serde(default)]
    pub allow_lossy: bool,
    /// Writes every line ending as `eol`. Without it, the lines of a file with
    /// mixed line endings that the save leaves unchanged keep their own.
    #[serde(default)]
    pub normalize_eol: bool,
    /// The encoding the file was read with, when the save changes it. Used only to
    /// read the old text when keeping mixed line endings; without it the old
    /// encoding is detected from the file.
    #[serde(default)]
    pub original_encoding: Option<Encoding>,
    /// Where the bytes after `tail_offset` come from, when not `path`: Save As of a
    /// partly loaded file streams the rest of the old file into the new one (M13).
    #[serde(default)]
    pub tail_path: Option<String>,
    /// The stamp `tail_path` must still have; otherwise the save fails with STALE.
    #[serde(default)]
    pub tail_stamp: Option<FileStamp>,
}

impl SaveRequest {
    /// The file the tail is copied from: `tail_path`, or the target itself.
    fn tail_source(&self, target: &Path) -> PathBuf {
        match &self.tail_path {
            Some(source) => resolve_target(Path::new(source)),
            None => target.to_path_buf(),
        }
    }
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileScan {
    pub chars: u64,
    pub lines: u64,
    /// Some bytes are not valid in the encoding (they read as U+FFFD).
    pub invalid: bool,
}

fn err(e: io::Error) -> String {
    e.to_string()
}

/// Opens for reading with full sharing. Other programs can edit, move or delete
/// the file while this handle exists, and the handle closes on drop.
pub fn open_shared(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(SHARE_ALL)
        .open(path)
}

fn stamp_of(meta: &fs::Metadata) -> FileStamp {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64);
    FileStamp {
        size: meta.len(),
        mtime_ms,
    }
}

pub fn stat(path: &Path) -> Result<Option<FileStamp>, String> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(Some(stamp_of(&meta))),
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

/// The system ANSI code page, or windows-1252 when it is one encoding_rs lacks
/// (including the UTF-8 "ACP", since this path only runs for non-UTF-8 data).
fn ansi_codec() -> &'static encoding_rs::Encoding {
    static CODEC: OnceLock<&'static encoding_rs::Encoding> = OnceLock::new();
    CODEC.get_or_init(|| {
        // SAFETY: plain Win32 query without arguments.
        let cp = unsafe { GetACP() };
        codec_for_code_page(cp).unwrap_or(encoding_rs::WINDOWS_1252)
    })
}

/// The encoding_rs codec for a Windows code page, when it has one. The OEM
/// pages 437 and 850 (and a few others) are not in the WHATWG set encoding_rs
/// implements, so they have none.
fn codec_for_code_page(cp: u32) -> Option<&'static encoding_rs::Encoding> {
    use encoding_rs as e;
    Some(match cp {
        866 => e::IBM866,
        874 => e::WINDOWS_874,
        932 => e::SHIFT_JIS,
        936 | 20936 => e::GBK,
        949 | 51949 => e::EUC_KR,
        950 => e::BIG5,
        1250 => e::WINDOWS_1250,
        1251 => e::WINDOWS_1251,
        1252 | 28591 => e::WINDOWS_1252,
        1253 => e::WINDOWS_1253,
        1254 | 28599 => e::WINDOWS_1254,
        1255 => e::WINDOWS_1255,
        1256 => e::WINDOWS_1256,
        1257 => e::WINDOWS_1257,
        1258 => e::WINDOWS_1258,
        10000 => e::MACINTOSH,
        10007 => e::X_MAC_CYRILLIC,
        20866 => e::KOI8_R,
        21866 => e::KOI8_U,
        20932 | 51932 => e::EUC_JP,
        28592 => e::ISO_8859_2,
        28593 => e::ISO_8859_3,
        28594 => e::ISO_8859_4,
        28595 => e::ISO_8859_5,
        28596 => e::ISO_8859_6,
        28597 => e::ISO_8859_7,
        28598 => e::ISO_8859_8,
        38598 => e::ISO_8859_8_I,
        28603 => e::ISO_8859_13,
        28605 => e::ISO_8859_15,
        50220..=50222 => e::ISO_2022_JP,
        54936 => e::GB18030,
        _ => return None,
    })
}

/// Returns the encoding and the BOM length. `complete` means `head` is the whole file.
fn detect_encoding(head: &[u8], complete: bool) -> (Encoding, usize) {
    if head.starts_with(BOM_UTF8) {
        return (Encoding::Utf8Bom, BOM_UTF8.len());
    }
    if head.starts_with(BOM_UTF16LE) {
        return (Encoding::Utf16Le, BOM_UTF16LE.len());
    }
    if head.starts_with(BOM_UTF16BE) {
        return (Encoding::Utf16Be, BOM_UTF16BE.len());
    }
    if let Some(encoding) = guess_utf16(head, complete) {
        return (encoding, 0);
    }
    match std::str::from_utf8(head) {
        Ok(_) => (Encoding::Utf8, 0),
        // A sequence cut off by the end of the window is still valid UTF-8.
        Err(e) if e.error_len().is_none() && !complete => (Encoding::Utf8, 0),
        Err(_) => (Encoding::Ansi, 0),
    }
}

/// The encoding the user chose, and the length of its BOM if the file has one.
/// A UTF-8 BOM is skipped for plain UTF-8 too, and then kept on save.
fn forced_encoding(head: &[u8], forced: Encoding) -> (Encoding, usize) {
    let forced = match forced {
        Encoding::Utf8 if head.starts_with(BOM_UTF8) => Encoding::Utf8Bom,
        other => other,
    };
    let bom = forced.bom();
    (forced, if head.starts_with(bom) { bom.len() } else { 0 })
}

/// UTF-16 without a BOM. Text that is mostly ASCII or Latin-1 has a zero in
/// every other byte when stored as UTF-16, while UTF-8 and ANSI text has none.
fn guess_utf16(head: &[u8], complete: bool) -> Option<Encoding> {
    if head.len() < 2 || (complete && head.len() % 2 == 1) {
        return None;
    }
    let pairs = head.len() / 2;
    let zeros = |parity: usize| (0..pairs).filter(|i| head[i * 2 + parity] == 0).count();
    let (even, odd) = (zeros(0), zeros(1));
    if odd * 2 >= pairs && even * 8 < odd {
        Some(Encoding::Utf16Le)
    } else if even * 2 >= pairs && odd * 8 < even {
        Some(Encoding::Utf16Be)
    } else {
        None
    }
}

/// The line ending of the first line. Works on raw bytes or UTF-16 units, so it
/// needs no decoding; a BOM is never mistaken for a line ending.
fn first_eol(bytes: &[u8], encoding: Encoding, complete: bool) -> Option<Eol> {
    let classify = |current: u16, next: Option<u16>| match (current, next) {
        (0x0A, _) => Some(Eol::Lf),
        (0x0D, Some(0x0A)) => Some(Eol::Crlf),
        (0x0D, Some(_)) => Some(Eol::Cr),
        (0x0D, None) => Some(if complete { Eol::Cr } else { Eol::Crlf }),
        _ => None,
    };
    match encoding {
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let units = whole_units(bytes);
            let unit = |i: usize| utf16_unit(bytes, i, encoding == Encoding::Utf16Be);
            (0..units).find_map(|i| classify(unit(i), (i + 1 < units).then(|| unit(i + 1))))
        }
        _ => (0..bytes.len())
            .find_map(|i| classify(bytes[i] as u16, bytes.get(i + 1).map(|&b| b as u16))),
    }
}

fn whole_units(bytes: &[u8]) -> usize {
    bytes.len() / 2
}

fn utf16_unit(bytes: &[u8], index: usize, big_endian: bool) -> u16 {
    let pair = [bytes[index * 2], bytes[index * 2 + 1]];
    if big_endian {
        u16::from_be_bytes(pair)
    } else {
        u16::from_le_bytes(pair)
    }
}

/// Where to end a chunk that does not reach end of file. `body` is at least
/// a few characters long, so the result is never 0.
fn find_cut(body: &[u8], encoding: Encoding) -> usize {
    match encoding {
        Encoding::Utf16Le => cut_utf16(body, false),
        Encoding::Utf16Be => cut_utf16(body, true),
        Encoding::Utf8 | Encoding::Utf8Bom => cut_bytes(body, utf8_char_cut),
        Encoding::Ansi => cut_ansi(body, ansi_codec()),
    }
}

fn cut_ansi(body: &[u8], codec: &'static encoding_rs::Encoding) -> usize {
    if codec.is_single_byte() {
        return cut_bytes(body, <[u8]>::len);
    }
    let width: fn(&[u8], usize) -> usize = if codec == encoding_rs::SHIFT_JIS {
        |bytes, i| 1 + usize::from(matches!(bytes[i], 0x81..=0x9F | 0xE0..=0xFC))
    } else if codec == encoding_rs::GB18030 {
        // Four bytes when the second is a digit, as in 0x81 0x30 0x81 0x30.
        |bytes, i| match (bytes[i], bytes.get(i + 1)) {
            (0x81..=0xFE, Some(0x30..=0x39)) => 4,
            (0x81..=0xFE, _) => 2,
            _ => 1,
        }
    } else if codec == encoding_rs::EUC_JP {
        |bytes, i| match bytes[i] {
            0x8F => 3,
            0x8E | 0xA1..=0xFE => 2,
            _ => 1,
        }
    } else {
        |bytes, i| 1 + usize::from(matches!(bytes[i], 0x81..=0xFE))
    };
    cut_bytes(body, |bytes| dbcs_char_cut(bytes, width))
}

/// CR and LF are never part of a multibyte sequence in UTF-8 or the ANSI code
/// pages, so a byte search finds real line boundaries.
fn cut_bytes(body: &[u8], char_cut: impl Fn(&[u8]) -> usize) -> usize {
    let len = body.len();
    for i in (0..len).rev() {
        // A CR in the last position may be half of a CRLF, so it is no boundary.
        if body[i] == b'\n' || (body[i] == b'\r' && i + 1 < len) {
            return i + 1;
        }
    }
    if body.last() == Some(&b'\r') {
        return len - 1;
    }
    char_cut(body)
}

fn utf8_char_cut(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=len.min(3) {
        let byte = bytes[len - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let needed = match byte {
            0xF0.. => 4,
            0xE0.. => 3,
            0xC0.. => 2,
            _ => 1,
        };
        return if needed > back { len - back } else { len };
    }
    len
}

/// Multibyte trail bytes overlap ASCII, so only a walk from the known
/// character boundary at the start of the window is reliable. `width` gives the
/// length of the character that starts at an index.
fn dbcs_char_cut(bytes: &[u8], width: fn(&[u8], usize) -> usize) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        let width = width(bytes, i);
        if i + width > bytes.len() {
            return i;
        }
        i += width;
    }
    i
}

fn cut_utf16(body: &[u8], big_endian: bool) -> usize {
    let units = whole_units(body);
    if units == 0 {
        return 0;
    }
    let unit = |i| utf16_unit(body, i, big_endian);
    for i in (0..units).rev() {
        if unit(i) == 0x0A || (unit(i) == 0x0D && i + 1 < units) {
            return (i + 1) * 2;
        }
    }
    let last = unit(units - 1);
    if last == 0x0D || (0xD800..=0xDBFF).contains(&last) {
        (units - 1) * 2
    } else {
        units * 2
    }
}

fn decode(bytes: &[u8], encoding: Encoding) -> String {
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => String::from_utf8_lossy(bytes).into_owned(),
        _ => encoding
            .codec()
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
    }
}

fn normalize_newlines(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

fn read_up_to(file: &mut File, want: usize) -> io::Result<Vec<u8>> {
    let mut window = Vec::with_capacity(want);
    Read::by_ref(file)
        .take(want as u64)
        .read_to_end(&mut window)?;
    Ok(window)
}

/// Encoding and line ending for a read that does not start at 0. The frontend
/// passes the encoding, so normally this only looks at the first few KiB, just
/// far enough to reach the first line ending.
fn known_format(file: &mut File, size: u64, hint: Option<Encoding>) -> io::Result<(Encoding, Eol)> {
    let mut head_len = if hint.is_some() {
        4 * 1024
    } else {
        FIRST_CHUNK
    };
    loop {
        file.seek(SeekFrom::Start(0))?;
        let head = read_up_to(file, head_len.min(size) as usize)?;
        let complete = head_len >= size;
        let encoding = hint.unwrap_or_else(|| detect_encoding(&head, complete).0);
        if let Some(eol) = first_eol(&head, encoding, complete) {
            return Ok((encoding, eol));
        }
        if complete || head_len >= FIRST_CHUNK {
            return Ok((encoding, Eol::Crlf));
        }
        head_len = (head_len * 8).min(FIRST_CHUNK);
    }
}

pub fn read_chunk(
    path: &Path,
    offset: u64,
    max_bytes: u64,
    hint: Option<Encoding>,
) -> Result<FileChunk, String> {
    let mut file = open_shared(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    let stamp = stamp_of(&meta);
    let size = meta.len();
    let offset = offset.min(size);
    let want = max_bytes.max(MIN_WINDOW).min(size - offset) as usize;

    file.seek(SeekFrom::Start(offset)).map_err(err)?;
    let window = read_up_to(&mut file, want).map_err(err)?;
    let eof = offset + window.len() as u64 >= size || window.len() < want;

    let (encoding, bom_len, known_eol) = if offset == 0 {
        // A hint at offset 0 is the user reopening the file with an encoding.
        let (encoding, bom_len) = match hint {
            Some(forced) => forced_encoding(&window, forced),
            None => detect_encoding(&window, eof),
        };
        (encoding, bom_len, first_eol(&window, encoding, eof))
    } else {
        let (encoding, eol) = known_format(&mut file, size, hint).map_err(err)?;
        (encoding, 0, Some(eol))
    };
    drop(file);

    let body = &window[bom_len..];
    let cut = if eof {
        body.len()
    } else {
        find_cut(body, encoding)
    };
    let eol = known_eol.unwrap_or(Eol::Crlf);
    let raw_text = decode(&body[..cut], encoding);
    let mixed_eol = has_other_eol(&raw_text, eol);
    let binary = raw_text.contains('\0');
    let text = if raw_text.contains('\r') {
        normalize_newlines(&raw_text).into_owned()
    } else {
        raw_text
    };

    Ok(FileChunk {
        text,
        next_offset: offset + (bom_len + cut) as u64,
        eof,
        encoding,
        eol,
        stamp,
        mixed_eol,
        read_only: offset == 0 && is_read_only(path, &meta),
        binary,
    })
}

/// True when `text` has a line ending other than `eol`. Chunks are never cut
/// between the CR and LF of a CRLF, so a chunk alone answers this.
fn has_other_eol(text: &str, eol: Eol) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let found = match bytes[i] {
            b'\n' => Eol::Lf,
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                i += 1;
                Eol::Crlf
            }
            b'\r' => Eol::Cr,
            _ => {
                i += 1;
                continue;
            }
        };
        if found != eol {
            return true;
        }
        i += 1;
    }
    false
}

/// The read-only attribute, or a folder or file ACL that refuses this user write
/// access. Opening for writing changes nothing on disk. Only "access denied"
/// counts: a sharing violation means another program has the file open, which
/// does not stop a save.
fn is_read_only(path: &Path, meta: &fs::Metadata) -> bool {
    if meta.permissions().readonly() {
        return true;
    }
    let opened = OpenOptions::new()
        .write(true)
        .share_mode(SHARE_ALL)
        .open(path);
    matches!(opened, Err(e) if e.kind() == io::ErrorKind::PermissionDenied)
}

/// Counts characters (UTF-16 code units, matching JS string length) and lines
/// after newline normalisation, with a fixed-size buffer.
pub fn scan(path: &Path, encoding: Encoding) -> Result<FileScan, String> {
    let mut file = open_shared(path).map_err(err)?;
    let bom = encoding.bom();
    let mut head = vec![0u8; bom.len()];
    let has_bom = !bom.is_empty() && file.read_exact(&mut head).is_ok() && head == bom;
    file.seek(SeekFrom::Start(if has_bom { bom.len() as u64 } else { 0 }))
        .map_err(err)?;

    let mut decoder = encoding.codec().new_decoder_without_bom_handling();
    let mut input = vec![0u8; STREAM_BUFFER];
    let mut output = vec![0u16; STREAM_BUFFER];
    let mut result = FileScan {
        chars: 0,
        lines: 1,
        invalid: false,
    };
    let mut after_cr = false;
    loop {
        let read = file.read(&mut input).map_err(err)?;
        let last = read == 0;
        let mut consumed = 0;
        loop {
            let (status, used, written, replaced) =
                decoder.decode_to_utf16(&input[consumed..read], &mut output, last);
            consumed += used;
            result.invalid |= replaced;
            for &unit in &output[..written] {
                let crlf_tail = after_cr && unit == 0x0A;
                after_cr = unit == 0x0D;
                if crlf_tail {
                    continue;
                }
                result.chars += 1;
                if unit == 0x0A || unit == 0x0D {
                    result.lines += 1;
                }
            }
            if status == CoderResult::InputEmpty {
                break;
            }
        }
        if last {
            return Ok(result);
        }
    }
}

fn eol_str(eol: Eol) -> &'static str {
    match eol {
        Eol::Crlf => "\r\n",
        Eol::Lf => "\n",
        Eol::Cr => "\r",
    }
}

/// The text with every line ending written as `eol`.
fn with_eol(text: &str, eol: Eol) -> Cow<'_, str> {
    let normalized = normalize_newlines(text);
    match eol {
        Eol::Lf => normalized,
        _ => Cow::Owned(normalized.replace('\n', eol_str(eol))),
    }
}

/// Encodes text whose line endings are final. Fails with the first character
/// the ANSI code page cannot hold, unless `lossy` turns those into `?`.
fn encode_str(text: &str, encoding: Encoding, lossy: bool) -> Result<Vec<u8>, char> {
    Ok(match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => text.as_bytes().to_vec(),
        Encoding::Utf16Le => text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        Encoding::Utf16Be => text.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        Encoding::Ansi => encode_ansi(text, lossy)?,
    })
}

#[cfg(test)]
fn encode_text(text: &str, eol: Eol, encoding: Encoding) -> Vec<u8> {
    encode_str(&with_eol(text, eol), encoding, true).expect("a lossy encode cannot fail")
}

/// With `lossy`, characters the code page cannot represent become `?`, as
/// Notepad does; without it the first one is returned as the error.
fn encode_ansi(text: &str, lossy: bool) -> Result<Vec<u8>, char> {
    let mut encoder = ansi_codec().new_encoder();
    let mut out = Vec::with_capacity(text.len());
    let mut rest = text;
    loop {
        let (status, read) =
            encoder.encode_from_utf8_to_vec_without_replacement(rest, &mut out, true);
        rest = &rest[read..];
        match status {
            encoding_rs::EncoderResult::InputEmpty => return Ok(out),
            encoding_rs::EncoderResult::OutputFull => out.reserve(rest.len().max(16)),
            encoding_rs::EncoderResult::Unmappable(c) if !lossy => return Err(c),
            encoding_rs::EncoderResult::Unmappable(_) => out.push(b'?'),
        }
    }
}

/// Splits text into lines, each with the line ending that follows it (none
/// for the last line).
fn split_lines(text: &str) -> Vec<(&str, Option<&'static str>)> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < bytes.len() {
        let ending = match bytes[i] {
            b'\n' => "\n",
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => "\r\n",
            b'\r' => "\r",
            _ => {
                i += 1;
                continue;
            }
        };
        lines.push((&text[start..i], Some(ending)));
        i += ending.len();
        start = i;
    }
    lines.push((&text[start..], None));
    lines
}

/// The ending to write after each new line but the last. Lines kept from the
/// old text keep their own ending; changed lines get `fallback`.
fn matched_endings(
    old: &[(&str, Option<&'static str>)],
    new: &[&str],
    fallback: &'static str,
) -> Vec<&'static str> {
    let mut endings = vec![fallback; new.len().saturating_sub(1)];
    let mut keep = |new_index: usize, old_index: usize| {
        if let (Some(slot), Some(ending)) = (endings.get_mut(new_index), old[old_index].1) {
            *slot = ending;
        }
    };
    if old.len() == new.len() {
        // Lines were edited in place, none added or removed.
        (0..new.len()).for_each(|i| keep(i, i));
        return endings;
    }
    let shorter = old.len().min(new.len());
    let prefix = (0..shorter).take_while(|&i| old[i].0 == new[i]).count();
    let suffix = (0..shorter - prefix)
        .take_while(|&k| old[old.len() - 1 - k].0 == new[new.len() - 1 - k])
        .count();
    (0..prefix).for_each(|i| keep(i, i));
    // The ending after the k-th line from the end lies inside the suffix when
    // the line after it is also part of the suffix.
    (1..suffix).for_each(|k| keep(new.len() - 1 - k, old.len() - 1 - k));
    endings
}

/// For a file with mixed line endings, the text to write with the endings of
/// unchanged lines kept, so a save does not rewrite every line. None when the
/// file is not mixed, cannot be read, or the request asks to normalise.
fn kept_line_endings(target: &Path, req: &SaveRequest) -> Option<String> {
    if req.normalize_eol {
        return None;
    }
    let mut file = open_shared(target).ok()?;
    let size = file.metadata().ok()?.len();
    let end = req.tail_offset.unwrap_or(size).min(size);
    if end > KEEP_EOL_MAX {
        return None;
    }
    let raw = read_up_to(&mut file, end as usize).ok()?;
    drop(file);
    let encoding = old_encoding(&raw, req);
    let body = raw.strip_prefix(encoding.bom()).unwrap_or(&raw[..]);
    let old_text = decode(body, encoding);
    let old = split_lines(&old_text);
    let first = old.iter().find_map(|line| line.1)?;
    if old.iter().all(|line| line.1.is_none_or(|e| e == first)) {
        return None;
    }
    let new_text = normalize_newlines(&req.text);
    let new: Vec<&str> = new_text.split('\n').collect();
    let endings = matched_endings(&old, &new, eol_str(req.eol));
    let mut out = String::with_capacity(new_text.len() + endings.len());
    for (i, line) in new.iter().enumerate() {
        out.push_str(line);
        if let Some(ending) = endings.get(i) {
            out.push_str(ending);
        }
    }
    Some(out)
}

/// The encoding the file on disk was written in, to read its old lines. The
/// request's own encoding is right unless the save changes it: the frontend can
/// say what it read the file with, and otherwise a BOM, or UTF-16 against
/// 8-bit text, shows the change.
fn old_encoding(raw: &[u8], req: &SaveRequest) -> Encoding {
    if let Some(encoding) = req.original_encoding {
        return encoding;
    }
    let is_utf16 = |e: Encoding| matches!(e, Encoding::Utf16Le | Encoding::Utf16Be);
    let (detected, bom_len) = detect_encoding(raw, true);
    if bom_len > 0 || is_utf16(detected) != is_utf16(req.encoding) {
        detected
    } else {
        req.encoding
    }
}

/// A temp file next to the target, removed on drop unless `keep` was called.
struct TempFile {
    path: PathBuf,
    keep: bool,
}

impl TempFile {
    fn create(target: &Path) -> io::Result<(Self, File)> {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let dir = target
            .parent()
            .ok_or_else(|| io::Error::other("path has no parent"))?;
        clean_stale_temps(dir);
        loop {
            let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = dir.join(format!("~notepadly-{}-{seq}.tmp", std::process::id()));
            let opened = OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(SHARE_ALL)
                .open(&path);
            match opened {
                Ok(file) => return Ok((Self { path, keep: false }, file)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    }
}

/// How old a temp file left by a crash must be before it is removed.
const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Removes `~notepadly-<pid>-<n>.tmp` files that a crash between creating the
/// temp file and swapping it in left next to the user's file: older than a day
/// and from a process that is no longer running. Each folder is looked at once
/// per run, at its first save.
fn clean_stale_temps(dir: &Path) {
    static CLEANED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let first_time = CLEANED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(dir.to_owned());
    if first_time {
        remove_stale_temps(dir, SystemTime::now());
    }
}

fn remove_stale_temps(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(stale_temp_pid) else {
            continue;
        };
        if pid == std::process::id() || process_alive(pid) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= STALE_TEMP_AGE);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The process id in a temp file name made by `TempFile::create`, or None for
/// any other name (including a temp file kept as the only copy of a save).
fn stale_temp_pid(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("~notepadly-")?.strip_suffix(".tmp")?;
    let (pid, seq) = rest.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if digits(pid) && digits(seq) {
        pid.parse().ok()
    } else {
        None
    }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain Win32 queries; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    false
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn ensure_fresh(target: &Path, expected: Option<FileStamp>) -> Result<(), String> {
    match expected {
        Some(stamp) if stat(target)? != Some(stamp) => Err(STALE.to_owned()),
        _ => Ok(()),
    }
}

/// A NUL-terminated wide path for a raw Win32 call. std adds the `\\?\`
/// long-path prefix to its own calls, but ReplaceFileW gets the raw path, so a
/// path longer than MAX_PATH gets the prefix here.
fn wide(path: &Path) -> Vec<u16> {
    let units: Vec<u16> = OsStr::new(path).encode_wide().collect();
    let (prefix, skip) = long_path_prefix(&units);
    let mut out: Vec<u16> = prefix.encode_utf16().collect();
    // Verbatim paths are not normalised, so `/` must already be `\`.
    let slash = if prefix.is_empty() {
        0
    } else {
        u16::from(b'/')
    };
    out.extend(
        units[skip..]
            .iter()
            .map(|&u| if u == slash { u16::from(b'\\') } else { u }),
    );
    out.push(0);
    out
}

/// The prefix for a path, and how many leading units it replaces: `\\?\` for a
/// long drive path, `\\?\UNC\` in place of the `\\` of a long network path,
/// and nothing for a short, relative or already prefixed one.
fn long_path_prefix(units: &[u16]) -> (&'static str, usize) {
    const MAX_PATH: usize = 260;
    let is_sep = |u: Option<&u16>| matches!(u, Some(&0x5C) | Some(&0x2F));
    if units.len() < MAX_PATH {
        return ("", 0);
    }
    let drive = units[0] < 0x80
        && (units[0] as u8).is_ascii_alphabetic()
        && units[1] == u16::from(b':')
        && is_sep(units.get(2));
    let unc = is_sep(units.first()) && is_sep(units.get(1));
    let verbatim = unc && matches!(units.get(2), Some(&0x3F) | Some(&0x2E)) && is_sep(units.get(3));
    if drive {
        (r"\\?\", 0)
    } else if unc && !verbatim {
        (r"\\?\UNC\", 2)
    } else {
        ("", 0)
    }
}

/// Replaces `target` with `temp`, keeping the target's attributes and ACLs.
fn replace_file(target: &Path, temp: &Path) -> io::Result<()> {
    let flags = REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS;
    let replaced = unsafe {
        ReplaceFileW(
            wide(target).as_ptr(),
            wide(temp).as_ptr(),
            std::ptr::null(),
            flags,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if replaced != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Error codes meaning another program holds the target open.
fn is_held_open(e: &io::Error) -> bool {
    const ACCESS_DENIED: i32 = 5;
    const SHARING_VIOLATION: i32 = 32;
    const LOCK_VIOLATION: i32 = 33;
    const UNABLE_TO_REMOVE_REPLACED: i32 = 1175;
    const UNABLE_TO_MOVE_REPLACEMENT: i32 = 1176;
    const UNABLE_TO_MOVE_REPLACEMENT_2: i32 = 1177;
    matches!(
        e.raw_os_error(),
        Some(
            ACCESS_DENIED
                | SHARING_VIOLATION
                | LOCK_VIOLATION
                | UNABLE_TO_REMOVE_REPLACED
                | UNABLE_TO_MOVE_REPLACEMENT
                | UNABLE_TO_MOVE_REPLACEMENT_2
        )
    )
}

/// Last resort when the target cannot be swapped out. The target is only
/// truncated after the new bytes are down, and if the copy fails partway the
/// temp file is kept, because it is then the only complete copy.
fn copy_over_in_place(temp: &mut TempFile, target: &Path) -> Result<(), String> {
    let mut source = open_shared(&temp.path).map_err(err)?;
    let new_len = source.metadata().map_err(err)?.len();
    // create(true): a failed ReplaceFile can leave the target already removed.
    let mut dest = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(SHARE_ALL)
        .open(target)
        .map_err(err)?;
    let copied = io::copy(&mut source, &mut dest)
        .and_then(|_| dest.set_len(new_len))
        .and_then(|_| dest.sync_all());
    copied.map_err(|e| {
        temp.keep = true;
        // A new name, so the clean-up of crashed saves never removes this copy.
        let kept = temp.path.with_extension("recovered.txt");
        if fs::rename(&temp.path, &kept).is_ok() {
            temp.path = kept;
        }
        format!("{e}; the saved text is in {}", temp.path.display())
    })
}

fn commit(temp: &mut TempFile, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(&temp.path, target).map_err(err);
    }
    match replace_file(target, &temp.path) {
        Ok(()) => Ok(()),
        Err(e) if is_held_open(&e) => copy_over_in_place(temp, target),
        Err(e) => Err(err(e)),
    }
}

fn append_tail(target: &Path, offset: u64, output: &mut impl Write) -> Result<(), String> {
    let mut source = open_shared(target).map_err(err)?;
    if offset > source.metadata().map_err(err)?.len() {
        return Err(STALE.to_owned());
    }
    source.seek(SeekFrom::Start(offset)).map_err(err)?;
    io::copy(&mut source, output).map_err(err)?;
    Ok(())
}

/// For a folder where the file can be written but no new file can be created
/// (some ACLs, drive roots, some network shares), so no temp file is possible.
/// Not atomic. The tail is read into memory first, because writing over the
/// file destroys the bytes it would be copied from.
fn write_in_place(target: &Path, req: &SaveRequest, bytes: &[u8]) -> Result<FileStamp, String> {
    let mut tail = Vec::new();
    if let Some(offset) = req.tail_offset {
        append_tail(&req.tail_source(target), offset, &mut tail)?;
    }
    let _serial = save_lock();
    ensure_fresh(target, req.expected_stamp)?;
    let mut dest = OpenOptions::new()
        .write(true)
        .truncate(false)
        .share_mode(SHARE_ALL)
        .open(target)
        .map_err(err)?;
    let bom = req.encoding.bom();
    let len = (bom.len() + bytes.len() + tail.len()) as u64;
    let mut write = || -> io::Result<()> {
        dest.write_all(bom)?;
        dest.write_all(bytes)?;
        dest.write_all(&tail)?;
        dest.set_len(len)?;
        dest.sync_all()
    };
    write().map_err(err)?;
    drop(dest);
    stat(target)?.ok_or_else(|| "file disappeared after saving".to_owned())
}

/// A rename would turn a symlink into a regular file, so save through it instead.
/// A broken link is saved to the path it points at, so it stays a link.
fn resolve_target(path: &Path) -> PathBuf {
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if !is_link {
        return path.to_owned();
    }
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    match (fs::read_link(path), path.parent()) {
        // A relative link is relative to the folder the link is in.
        (Ok(dest), Some(dir)) => dir.join(dest),
        (Ok(dest), None) => dest,
        _ => path.to_owned(),
    }
}

/// Serialises the last freshness check and the swap of every save in this
/// process, so two windows saving the same file at once cannot both pass the
/// check before either writes (RUST-7). Other programs remain a race, as in any
/// editor.
fn save_lock() -> MutexGuard<'static, ()> {
    static SAVE_LOCK: Mutex<()> = Mutex::new(());
    SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// An NTFS alternate data stream (`notes.txt:secret`): the last component holds
/// a `:`, which a plain file name never can. Neither ReplaceFileW nor a rename
/// works on one (RUST-4).
fn is_stream_path(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().contains(':'))
}

/// How many hard links the file has, when that can be read.
#[cfg(windows)]
fn link_count(path: &Path) -> Option<u32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file = open_shared(path).ok()?;
    // SAFETY: the struct is plain data that the call fills in; the handle stays
    // open (owned by `file`) for the duration of the call.
    unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let ok = GetFileInformationByHandle(file.as_raw_handle() as _, &mut info);
        (ok != 0).then_some(info.nNumberOfLinks)
    }
}

#[cfg(not(windows))]
fn link_count(path: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).ok().map(|m| m.nlink() as u32)
}

/// The save must write into the existing file rather than swap a new one in:
/// a stream cannot be swapped, and a swap gives a file with several hard links
/// a new identity, cutting it off from its other names. Notepad writes in
/// place in both cases.
fn must_write_in_place(target: &Path) -> bool {
    is_stream_path(target) || link_count(target).is_some_and(|n| n > 1)
}

pub fn save(req: &SaveRequest) -> Result<FileStamp, String> {
    let target = resolve_target(Path::new(&req.path));
    ensure_fresh(&target, req.expected_stamp)?;
    if req.tail_path.is_some() {
        ensure_fresh(&req.tail_source(&target), req.tail_stamp)?;
    }

    let bytes = {
        let kept = kept_line_endings(&target, req);
        let text = match &kept {
            Some(text) => Cow::Borrowed(text.as_str()),
            None => with_eol(&req.text, req.eol),
        };
        encode_str(&text, req.encoding, req.allow_lossy)
            .map_err(|c| format!("{UNMAPPABLE}: {c}"))?
    };
    let (mut temp, mut output) = match TempFile::create(&target) {
        Ok(created) => created,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied && target.is_file() => {
            return write_in_place(&target, req, &bytes);
        }
        Err(e) => return Err(err(e)),
    };
    output.write_all(req.encoding.bom()).map_err(err)?;
    output.write_all(&bytes).map_err(err)?;
    drop(bytes);
    if let Some(offset) = req.tail_offset {
        append_tail(&req.tail_source(&target), offset, &mut output)?;
    }
    output.sync_all().map_err(err)?;
    drop(output);

    // The file may have changed while the tail was being copied.
    let _serial = save_lock();
    ensure_fresh(&target, req.expected_stamp)?;
    if req.tail_path.is_some() {
        ensure_fresh(&req.tail_source(&target), req.tail_stamp)?;
    }
    if must_write_in_place(&target) {
        // The complete text is in the temp file first, so a failed copy loses
        // nothing: the temp file is then kept and named in the error.
        copy_over_in_place(&mut temp, &target)?;
    } else {
        commit(&mut temp, &target)?;
    }
    stat(&target)?.ok_or_else(|| "file disappeared after saving".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LE: Encoding = Encoding::Utf16Le;
    const BE: Encoding = Encoding::Utf16Be;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("notepadly-test-{}-{id}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, bytes: &[u8]) -> PathBuf {
            let path = self.0.join("doc.txt");
            fs::write(&path, bytes).unwrap();
            path
        }

        fn entries(&self) -> usize {
            fs::read_dir(&self.0).unwrap().count()
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// BOM plus the text as is, line endings untouched.
    fn raw_utf16(text: &str, encoding: Encoding) -> Vec<u8> {
        let mut out = encoding.bom().to_vec();
        out.extend(encode_str(text, encoding, true).unwrap());
        out
    }

    fn utf16(text: &str, encoding: Encoding) -> Vec<u8> {
        let mut out = encoding.bom().to_vec();
        out.extend(encode_text(text, Eol::Lf, encoding));
        out
    }

    /// Reads a file chunk by chunk, checking every chunk against the raw bytes
    /// it claims to cover. Returns the concatenated text.
    fn walk(path: &Path, window: u64) -> String {
        let raw = fs::read(path).unwrap();
        let mut text = String::new();
        let mut offset = 0;
        let mut encoding = None;
        loop {
            let chunk = read_chunk(path, offset, window, encoding).unwrap();
            let start = if offset == 0 {
                chunk.encoding.bom().len()
            } else {
                offset as usize
            };
            let expected = decode(&raw[start..chunk.next_offset as usize], chunk.encoding);
            assert_eq!(
                chunk.text,
                normalize_newlines(&expected),
                "window {window} at {offset}"
            );
            assert!(
                !chunk.text.contains('\u{FFFD}'),
                "split character, window {window}"
            );
            text.push_str(&chunk.text);
            if chunk.eof {
                assert_eq!(chunk.next_offset, raw.len() as u64);
                return text;
            }
            assert!(chunk.next_offset > offset, "no progress, window {window}");
            offset = chunk.next_offset;
            encoding = Some(chunk.encoding);
        }
    }

    fn assert_every_window_round_trips(bytes: &[u8], expected: &str) {
        let dir = TestDir::new();
        let path = dir.file(bytes);
        for window in 1..=64 {
            assert_eq!(walk(&path, window), expected, "window {window}");
        }
    }

    #[test]
    fn utf8_multibyte_is_never_split() {
        let text = "aé€😀b".repeat(20) + "\nسلام دنیا\n" + &"😀".repeat(40);
        assert_every_window_round_trips(text.as_bytes(), &text);
    }

    #[test]
    fn utf8_bom_is_skipped_and_counted_in_offsets() {
        let text = "é😀 line\nsecond".repeat(10);
        let mut bytes = BOM_UTF8.to_vec();
        bytes.extend(text.as_bytes());
        assert_every_window_round_trips(&bytes, &text);
    }

    #[test]
    fn crlf_and_cr_are_normalized_across_every_cut() {
        let source = "one\r\ntwo\rthree\n\r\nfour\r\n".repeat(8);
        let expected = source.replace("\r\n", "\n").replace('\r', "\n");
        assert_every_window_round_trips(source.as_bytes(), &expected);
    }

    #[test]
    fn utf16_units_surrogates_and_crlf_survive_every_cut() {
        let text = "a😀\r\nسلام\rb😀😀\r\n".repeat(8);
        let expected = text.replace("\r\n", "\n").replace('\r', "\n");
        for encoding in [LE, BE] {
            let mut bytes = encoding.bom().to_vec();
            let units: Vec<u16> = text.encode_utf16().collect();
            for unit in units {
                bytes.extend(if encoding == LE {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            assert_every_window_round_trips(&bytes, &expected);
        }
    }

    #[test]
    fn utf8_cut_lands_before_a_partial_character() {
        let dir = TestDir::new();
        let path = dir.file("abcdef😀 tail".as_bytes());
        let chunk = read_chunk(&path, 0, 8, None).unwrap();
        assert_eq!(
            (chunk.text.as_str(), chunk.next_offset, chunk.eof),
            ("abcdef", 6, false)
        );
    }

    #[test]
    fn crlf_straddling_the_window_is_left_whole() {
        let dir = TestDir::new();
        let path = dir.file(b"abcdefg\r\nhij");
        let chunk = read_chunk(&path, 0, 8, None).unwrap();
        assert_eq!((chunk.text.as_str(), chunk.next_offset), ("abcdefg", 7));
        let next = read_chunk(&path, 7, 8, Some(Encoding::Utf8)).unwrap();
        assert_eq!(
            (next.text.as_str(), next.next_offset, next.eof),
            ("\nhij", 12, true)
        );
    }

    #[test]
    fn cut_prefers_the_last_complete_line() {
        let dir = TestDir::new();
        let path = dir.file(b"a\nbcdef\r\nX");
        let chunk = read_chunk(&path, 0, 8, None).unwrap();
        assert_eq!((chunk.text.as_str(), chunk.next_offset), ("a\n", 2));
    }

    #[test]
    fn utf16_cut_does_not_split_surrogates_or_crlf() {
        let dir = TestDir::new();
        for encoding in [LE, BE] {
            // BOM, a, b, then a surrogate pair straddling the 8 byte window.
            let path = dir.file(&utf16("ab😀cd", encoding));
            let chunk = read_chunk(&path, 0, 8, None).unwrap();
            assert_eq!((chunk.text.as_str(), chunk.next_offset), ("ab", 6));
            assert_eq!(chunk.encoding, encoding);

            let mut with_crlf = utf16("ab", encoding);
            with_crlf.extend(encode_text("\ncd", Eol::Crlf, encoding));
            let path = dir.file(&with_crlf);
            let chunk = read_chunk(&path, 0, 8, None).unwrap();
            assert_eq!((chunk.text.as_str(), chunk.next_offset), ("ab", 6));
        }
    }

    #[test]
    fn multibyte_ansi_cut_respects_trail_bytes() {
        // 0x83 0x41 is one Shift_JIS character whose trail byte is ASCII 'A'.
        let bytes = [b'a', 0x83, 0x41, 0x83];
        let sjis: fn(&[u8], usize) -> usize =
            |b, i| 1 + usize::from(matches!(b[i], 0x81..=0x9F | 0xE0..=0xFC));
        assert_eq!(dbcs_char_cut(&bytes, sjis), 3);
        assert_eq!(cut_ansi(&bytes, encoding_rs::SHIFT_JIS), 3);
        assert_eq!(cut_ansi(&bytes, encoding_rs::WINDOWS_1252), 4);
    }

    #[test]
    fn detects_encoding_and_eol() {
        assert_eq!(detect_encoding(b"plain", true), (Encoding::Utf8, 0));
        assert_eq!(
            detect_encoding(&[0xEF, 0xBB, 0xBF, b'a'], true),
            (Encoding::Utf8Bom, 3)
        );
        assert_eq!(detect_encoding(&[0xFF, 0xFE, b'a', 0], true), (LE, 2));
        assert_eq!(detect_encoding(&[0xFE, 0xFF, 0, b'a'], true), (BE, 2));
        assert_eq!(
            detect_encoding(&[b'a', 0xE9, b'b'], true),
            (Encoding::Ansi, 0)
        );
        // A window ending inside a valid sequence is still UTF-8, unless that is the file's end.
        assert_eq!(detect_encoding(&[b'a', 0xC3], false), (Encoding::Utf8, 0));
        assert_eq!(detect_encoding(&[b'a', 0xC3], true), (Encoding::Ansi, 0));

        assert_eq!(
            first_eol(b"a\r\nb\n", Encoding::Utf8, true),
            Some(Eol::Crlf)
        );
        assert_eq!(first_eol(b"a\nb\r\n", Encoding::Utf8, true), Some(Eol::Lf));
        assert_eq!(first_eol(b"a\rb", Encoding::Utf8, true), Some(Eol::Cr));
        assert_eq!(first_eol(b"abc", Encoding::Utf8, true), None);
        assert_eq!(first_eol(&utf16("a\nb", BE), BE, true), Some(Eol::Lf));
        // A CR that ends a cut-off window may be the first half of a CRLF.
        assert_eq!(first_eol(b"a\r", Encoding::Utf8, false), Some(Eol::Crlf));
        assert_eq!(first_eol(b"a\r", Encoding::Utf8, true), Some(Eol::Cr));
    }

    #[test]
    fn later_chunks_repeat_the_first_chunk_eol() {
        let dir = TestDir::new();
        // The later window contains only LF endings; the file's first ending is CRLF.
        let path = dir.file(b"first\r\nsecond\nthird\nfourth\n");
        assert_eq!(read_chunk(&path, 0, 8, None).unwrap().eol, Eol::Crlf);
        assert_eq!(
            read_chunk(&path, 13, 8, Some(Encoding::Utf8)).unwrap().eol,
            Eol::Crlf
        );
        assert_eq!(
            read_chunk(&path, 13, 8, None).unwrap().encoding,
            Encoding::Utf8
        );
    }

    #[test]
    fn read_returns_only_the_window_and_handles_offsets_past_the_end() {
        let dir = TestDir::new();
        let path = dir.file(&vec![b'x'; 1024 * 1024]);
        let chunk = read_chunk(&path, 0, 4096, None).unwrap();
        assert_eq!(
            (chunk.text.len(), chunk.next_offset, chunk.eof),
            (4096, 4096, false)
        );

        let past = read_chunk(&path, 5 * 1024 * 1024, 4096, Some(Encoding::Utf8)).unwrap();
        assert_eq!(
            (past.text.as_str(), past.next_offset, past.eof),
            ("", 1024 * 1024, true)
        );

        let empty = dir.file(b"");
        let chunk = read_chunk(&empty, 0, 4096, None).unwrap();
        assert_eq!(
            (chunk.text.as_str(), chunk.eof, chunk.encoding, chunk.eol),
            ("", true, Encoding::Utf8, Eol::Crlf)
        );
    }

    fn request(path: &Path, text: &str, eol: Eol, encoding: Encoding) -> SaveRequest {
        SaveRequest {
            path: path.to_string_lossy().into_owned(),
            text: text.to_owned(),
            eol,
            encoding,
            tail_offset: None,
            expected_stamp: None,
            allow_lossy: false,
            normalize_eol: false,
            original_encoding: None,
            tail_path: None,
            tail_stamp: None,
        }
    }

    #[test]
    fn save_as_streams_the_tail_of_another_file() {
        let dir = TestDir::new();
        let source = dir.file(b"line one\nline two\nline three\n");
        let first = read_chunk(&source, 0, 9, None).unwrap();
        let target = dir.0.join("copy.txt");
        let mut req = request(&target, "LINE ONE\n", Eol::Lf, Encoding::Utf8);
        req.tail_offset = Some(first.next_offset);
        req.tail_path = Some(source.to_string_lossy().into_owned());
        req.tail_stamp = Some(first.stamp);
        save(&req).unwrap();
        let expected = format!(
            "LINE ONE\n{}",
            &"line one\nline two\nline three\n"[first.next_offset as usize..]
        );
        assert_eq!(fs::read(&target).unwrap(), expected.as_bytes());
        assert_eq!(
            fs::read(&source).unwrap(),
            b"line one\nline two\nline three\n"
        );

        // A source changed since it was read is refused.
        fs::write(&source, b"changed by someone else, and longer").unwrap();
        let other = dir.0.join("other.txt");
        req.path = other.to_string_lossy().into_owned();
        assert_eq!(save(&req).unwrap_err(), "STALE");
        assert!(!other.exists());
    }

    #[test]
    fn save_writes_the_bom_and_eol_of_each_encoding() {
        let dir = TestDir::new();
        let path = dir.0.join("new.txt");
        let cases: [(Encoding, &[u8]); 4] = [
            (Encoding::Utf8, b"a\r\nb"),
            (
                Encoding::Utf8Bom,
                &[0xEF, 0xBB, 0xBF, b'a', b'\r', b'\n', b'b'],
            ),
            (LE, &[0xFF, 0xFE, b'a', 0, b'\r', 0, b'\n', 0, b'b', 0]),
            (BE, &[0xFE, 0xFF, 0, b'a', 0, b'\r', 0, b'\n', 0, b'b']),
        ];
        for (encoding, expected) in cases {
            save(&request(&path, "a\nb", Eol::Crlf, encoding)).unwrap();
            assert_eq!(fs::read(&path).unwrap(), expected, "{encoding:?}");
            let chunk = read_chunk(&path, 0, 1024, None).unwrap();
            assert_eq!(
                (chunk.text.as_str(), chunk.encoding, chunk.eol),
                ("a\nb", encoding, Eol::Crlf)
            );
        }
        assert_eq!(dir.entries(), 1, "temp file left behind");

        save(&request(&path, "a\nb", Eol::Lf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\nb");
        save(&request(&path, "a\nb", Eol::Cr, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\rb");

        // Lossy, so the test does not depend on the machine's code page.
        let mut cafe = request(&path, "caf\u{e9}", Eol::Lf, Encoding::Ansi);
        cafe.allow_lossy = true;
        save(&cafe).unwrap();
        if ansi_codec().is_single_byte() && ansi_codec() == encoding_rs::WINDOWS_1252 {
            assert_eq!(fs::read(&path).unwrap(), b"caf\xE9");
            let chunk = read_chunk(&path, 0, 1024, None).unwrap();
            assert_eq!(
                (chunk.text.as_str(), chunk.encoding),
                ("caf\u{e9}", Encoding::Ansi)
            );
            // BUGS.md C6: a character the code page lacks is refused, not silently
            // turned into `?`, unless the caller allows that.
            let mut lossy = request(&path, "x\u{4E2D}y", Eol::Lf, Encoding::Ansi);
            assert_eq!(save(&lossy).unwrap_err(), "UNMAPPABLE: \u{4E2D}");
            assert_eq!(fs::read(&path).unwrap(), b"caf\xE9");
            lossy.allow_lossy = true;
            save(&lossy).unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"x?y");
        }
        // Every character fits in UTF-8 and UTF-16, so those never refuse.
        save(&request(&path, "x\u{4E2D}y", Eol::Lf, Encoding::Utf8)).unwrap();
        assert_eq!(dir.entries(), 1, "temp file left behind");
    }

    #[test]
    fn unmappable_ansi_text_is_reported_with_its_first_character() {
        let all_ascii = encode_ansi("plain text", false).unwrap();
        assert_eq!(all_ascii, b"plain text");
        // No ANSI code page holds both Urdu and CJK, and none holds emoji.
        assert_eq!(encode_ansi("ok 😀 \u{4E2D}", false).unwrap_err(), '😀');
        assert_eq!(encode_ansi("ok 😀", true).unwrap(), b"ok ?");
    }

    #[test]
    fn tail_save_writes_bom_new_text_then_original_bytes() {
        for encoding in [Encoding::Utf8, Encoding::Utf8Bom, LE, BE] {
            let dir = TestDir::new();
            let original_text = "héllo 😀 line\r\n".repeat(30_000);
            let mut original = encoding.bom().to_vec();
            match encoding {
                LE => original.extend(original_text.encode_utf16().flat_map(u16::to_le_bytes)),
                BE => original.extend(original_text.encode_utf16().flat_map(u16::to_be_bytes)),
                _ => original.extend(original_text.as_bytes()),
            }
            let path = dir.file(&original);

            let first = read_chunk(&path, 0, 64 * 1024, None).unwrap();
            assert_eq!(
                (first.encoding, first.eof, first.eol),
                (encoding, false, Eol::Crlf)
            );
            let edited = format!("EDITED\n{}", first.text);
            let mut req = request(&path, &edited, Eol::Crlf, encoding);
            req.tail_offset = Some(first.next_offset);
            req.expected_stamp = Some(first.stamp);
            let stamp = save(&req).unwrap();

            let mut expected = encoding.bom().to_vec();
            expected.extend(encode_text(&edited, Eol::Crlf, encoding));
            expected.extend(&original[first.next_offset as usize..]);
            let saved = fs::read(&path).unwrap();
            assert!(saved == expected, "{encoding:?}: saved bytes differ");
            assert_eq!(stat(&path).unwrap(), Some(stamp));
            assert_eq!(dir.entries(), 1, "temp file left behind");

            let reread = walk(&path, 64 * 1024);
            assert_eq!(
                reread,
                format!("EDITED\n{}", original_text.replace("\r\n", "\n"))
            );
        }
    }

    #[test]
    fn stale_saves_are_rejected_and_change_nothing() {
        let dir = TestDir::new();
        let path = dir.file(b"line one\nline two\nline three\n");
        let first = read_chunk(&path, 0, 12, None).unwrap();
        fs::write(&path, b"someone else wrote this").unwrap();

        let mut req = request(&path, "mine\n", Eol::Lf, Encoding::Utf8);
        req.tail_offset = Some(first.next_offset);
        req.expected_stamp = Some(first.stamp);
        assert_eq!(save(&req).unwrap_err(), "STALE");
        assert_eq!(fs::read(&path).unwrap(), b"someone else wrote this");

        fs::remove_file(&path).unwrap();
        assert_eq!(save(&req).unwrap_err(), "STALE");
        assert!(!path.exists());
        assert_eq!(dir.entries(), 0, "temp file left behind");
    }

    #[test]
    fn stamp_survives_a_js_style_json_round_trip() {
        // JS prints whole numbers without a decimal point.
        let dir = TestDir::new();
        let path = dir.file(b"x");
        let stamp = stat(&path).unwrap().unwrap();
        assert_eq!(stamp.mtime_ms.fract(), 0.0);
        let js = format!(
            r#"{{"size":{},"mtimeMs":{}}}"#,
            stamp.size, stamp.mtime_ms as u64
        );
        assert_eq!(serde_json::from_str::<FileStamp>(&js).unwrap(), stamp);
    }

    #[test]
    fn no_lock_remains_after_any_operation() {
        let dir = TestDir::new();
        let path = dir.file(b"hello\r\nworld\r\n");

        let assert_unlocked = |path: &Path| {
            // share_mode(0) only succeeds when no other handle is open anywhere.
            OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(path)
                .expect("a handle was left open");
        };

        let chunk = read_chunk(&path, 0, 8, None).unwrap();
        assert_unlocked(&path);
        read_chunk(&path, chunk.next_offset, 8, Some(chunk.encoding)).unwrap();
        assert_unlocked(&path);
        scan(&path, Encoding::Utf8).unwrap();
        assert_unlocked(&path);
        stat(&path).unwrap();
        assert_unlocked(&path);
        save(&request(&path, "new", Eol::Lf, Encoding::Utf8)).unwrap();
        assert_unlocked(&path);
    }

    #[test]
    fn another_program_can_rename_overwrite_and_delete_right_after_a_read() {
        let dir = TestDir::new();
        let path = dir.file(b"original contents\n");
        read_chunk(&path, 0, 1024, None).unwrap();

        let moved = dir.0.join("moved.txt");
        fs::rename(&path, &moved).unwrap();
        read_chunk(&moved, 0, 1024, None).unwrap();

        let replacement = dir.0.join("replacement.txt");
        fs::write(&replacement, b"replaced").unwrap();
        fs::rename(&replacement, &moved).unwrap();
        let chunk = read_chunk(&moved, 0, 1024, None).unwrap();
        assert_eq!(chunk.text, "replaced");

        let mut writer = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&moved)
            .unwrap();
        writer.write_all(b"overwritten").unwrap();
        drop(writer);
        assert_eq!(
            read_chunk(&moved, 0, 1024, None).unwrap().text,
            "overwritten"
        );

        fs::remove_file(&moved).unwrap();
        assert_eq!(stat(&moved).unwrap(), None);
    }

    #[test]
    fn reads_work_while_another_program_has_the_file_open() {
        let dir = TestDir::new();
        let path = dir.file(b"shared\n");
        let _writer = OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();
        assert_eq!(read_chunk(&path, 0, 1024, None).unwrap().text, "shared\n");
        assert_eq!(scan(&path, Encoding::Utf8).unwrap().lines, 2);
    }

    #[test]
    fn replace_failure_falls_back_to_writing_in_place() {
        let dir = TestDir::new();
        let path = dir.file(b"line one\nline two\nline three\n");
        let first = read_chunk(&path, 0, 12, None).unwrap();

        // Open without FILE_SHARE_DELETE, so the target cannot be swapped out.
        let holder = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .unwrap();

        let mut tail = request(&path, "EDIT\n", Eol::Lf, Encoding::Utf8);
        tail.tail_offset = Some(first.next_offset);
        tail.expected_stamp = Some(first.stamp);
        save(&tail).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"EDIT\nline two\nline three\n");

        save(&request(&path, "short", Eol::Lf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"short");
        drop(holder);
        assert_eq!(dir.entries(), 1, "temp file left behind");
    }

    #[test]
    fn exclusive_lock_reports_an_error_and_keeps_the_original() {
        let dir = TestDir::new();
        let path = dir.file(b"keep me");
        let holder = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(save(&request(&path, "new", Eol::Lf, Encoding::Utf8)).is_err());
        drop(holder);
        assert_eq!(fs::read(&path).unwrap(), b"keep me");
        assert_eq!(dir.entries(), 1, "temp file left behind");
    }

    #[test]
    fn replace_preserves_file_attributes() {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        let dir = TestDir::new();
        let path = dir.0.join("hidden.txt");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .attributes(HIDDEN)
            .open(&path)
            .unwrap()
            .write_all(b"secret")
            .unwrap();
        save(&request(&path, "new", Eol::Lf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_ne!(fs::metadata(&path).unwrap().file_attributes() & HIDDEN, 0);
    }

    #[test]
    fn scan_counts_like_a_js_string_across_buffer_boundaries() {
        let dir = TestDir::new();
        // The CRLF pairs and surrogate pairs land on every alignment of the buffer.
        let pad = "x".repeat(STREAM_BUFFER - 1);
        let text = format!("{pad}\r\n{pad}😀\n{pad}\ré\r\n");
        let path = dir.file(text.as_bytes());
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let expected = FileScan {
            chars: normalized.encode_utf16().count() as u64,
            lines: normalized.matches('\n').count() as u64 + 1,
            invalid: false,
        };
        assert_eq!(scan(&path, Encoding::Utf8).unwrap(), expected);

        let mut bom = BOM_UTF8.to_vec();
        bom.extend(text.as_bytes());
        assert_eq!(scan(&dir.file(&bom), Encoding::Utf8Bom).unwrap(), expected);

        for encoding in [LE, BE] {
            let mut bytes = encoding.bom().to_vec();
            for unit in text.encode_utf16() {
                bytes.extend(if encoding == LE {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            assert_eq!(scan(&dir.file(&bytes), encoding).unwrap(), expected);
        }

        assert_eq!(
            scan(&dir.file(b""), Encoding::Utf8).unwrap(),
            FileScan {
                chars: 0,
                lines: 1,
                invalid: false
            }
        );
    }

    #[test]
    fn wire_format_matches_the_contract() {
        for (name, value) in [
            (r#""utf-8""#, Encoding::Utf8),
            (r#""utf-8-bom""#, Encoding::Utf8Bom),
            (r#""utf-16le""#, LE),
            (r#""utf-16be""#, BE),
            (r#""ansi""#, Encoding::Ansi),
        ] {
            assert_eq!(serde_json::from_str::<Encoding>(name).unwrap(), value);
            assert_eq!(serde_json::to_string(&value).unwrap(), name);
        }
        for (name, value) in [
            (r#""CRLF""#, Eol::Crlf),
            (r#""LF""#, Eol::Lf),
            (r#""CR""#, Eol::Cr),
        ] {
            assert_eq!(serde_json::from_str::<Eol>(name).unwrap(), value);
            assert_eq!(serde_json::to_string(&value).unwrap(), name);
        }

        let req: SaveRequest = serde_json::from_str(
            r#"{"path":"p","text":"t","eol":"LF","encoding":"ansi","tailOffset":7,
                "expectedStamp":{"size":1,"mtimeMs":2}}"#,
        )
        .unwrap();
        assert_eq!(req.tail_offset, Some(7));
        assert_eq!(
            req.expected_stamp,
            Some(FileStamp {
                size: 1,
                mtime_ms: 2.0
            })
        );

        let chunk = FileChunk {
            text: "t".into(),
            next_offset: 3,
            eof: true,
            encoding: Encoding::Utf8,
            eol: Eol::Lf,
            stamp: FileStamp {
                size: 1,
                mtime_ms: 2.0,
            },
            mixed_eol: true,
            read_only: true,
            binary: false,
        };
        let value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(value["nextOffset"], 3);
        assert_eq!(value["stamp"]["mtimeMs"], 2.0);
        assert_eq!(value["mixedEol"], true);
        assert_eq!(value["readOnly"], true);
        assert_eq!(value["binary"], false);

        let req: SaveRequest = serde_json::from_str(
            r#"{"path":"p","text":"t","eol":"LF","encoding":"utf-8",
                "normalizeEol":true,"originalEncoding":"utf-16le"}"#,
        )
        .unwrap();
        assert!(req.normalize_eol);
        assert_eq!(req.original_encoding, Some(LE));
    }

    #[test]
    fn saves_and_reads_paths_with_spaces_and_unicode() {
        let dir = TestDir::new();
        let folder = dir.0.join("My Notes اردو");
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("ہیلو 😀 file.md");
        let stamp = save(&request(&path, "سلام\nدنیا", Eol::Crlf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), "سلام\r\nدنیا".as_bytes());
        assert_eq!(stat(&path).unwrap(), Some(stamp));
        let chunk = read_chunk(&path, 0, 1024, None).unwrap();
        assert_eq!(
            (chunk.text.as_str(), chunk.eol, chunk.eof),
            ("سلام\nدنیا", Eol::Crlf, true)
        );
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 1, "temp file left");
    }

    #[test]
    fn empty_documents_round_trip_in_every_encoding() {
        let dir = TestDir::new();
        let path = dir.0.join("empty.txt");
        for encoding in [Encoding::Utf8, Encoding::Utf8Bom, LE, BE] {
            save(&request(&path, "", Eol::Crlf, encoding)).unwrap();
            assert_eq!(fs::read(&path).unwrap(), encoding.bom(), "{encoding:?}");
            let chunk = read_chunk(&path, 0, 1024, None).unwrap();
            assert_eq!((chunk.text.as_str(), chunk.eof), ("", true), "{encoding:?}");
            // A BOM-only file keeps its encoding, so the next save writes it back.
            let expected = if encoding == Encoding::Utf8 {
                Encoding::Utf8
            } else {
                encoding
            };
            assert_eq!(chunk.encoding, expected);
        }
    }

    #[test]
    fn classic_mac_cr_files_keep_their_line_endings() {
        let dir = TestDir::new();
        let path = dir.file(b"one\rtwo\rthree");
        let chunk = read_chunk(&path, 0, 1024, None).unwrap();
        assert_eq!(
            (chunk.text.as_str(), chunk.eol),
            ("one\ntwo\nthree", Eol::Cr)
        );
        save(&request(&path, &chunk.text, chunk.eol, chunk.encoding)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one\rtwo\rthree");
        assert_eq!(scan(&path, Encoding::Utf8).unwrap().lines, 3);
    }

    #[test]
    fn text_that_already_has_crlf_is_not_doubled() {
        assert_eq!(
            encode_text("a\r\nb\rc\n", Eol::Crlf, Encoding::Utf8),
            b"a\r\nb\r\nc\r\n"
        );
        assert_eq!(
            encode_text("a\r\nb", Eol::Lf, Encoding::Utf8),
            b"a\nb".to_vec()
        );
    }

    #[test]
    fn a_trailing_newline_survives_the_round_trip() {
        let dir = TestDir::new();
        let path = dir.file(b"line\r\n");
        let chunk = read_chunk(&path, 0, 1024, None).unwrap();
        assert_eq!(chunk.text, "line\n");
        save(&request(&path, &chunk.text, chunk.eol, chunk.encoding)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"line\r\n");
    }

    #[test]
    fn a_save_with_the_current_stamp_succeeds() {
        let dir = TestDir::new();
        let path = dir.file(b"old");
        let mut req = request(&path, "new", Eol::Lf, Encoding::Utf8);
        req.expected_stamp = stat(&path).unwrap();
        let stamp = save(&req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(stamp.size, 3);
    }

    #[test]
    fn a_tail_offset_past_the_end_is_stale_and_changes_nothing() {
        let dir = TestDir::new();
        let path = dir.file(b"short");
        let mut req = request(&path, "x", Eol::Lf, Encoding::Utf8);
        req.tail_offset = Some(100);
        assert_eq!(save(&req).unwrap_err(), "STALE");
        assert_eq!(fs::read(&path).unwrap(), b"short");
        assert_eq!(dir.entries(), 1, "temp file left behind");
    }

    #[test]
    fn folders_and_missing_files_are_not_files() {
        let dir = TestDir::new();
        assert_eq!(stat(&dir.0).unwrap(), None);
        assert_eq!(stat(&dir.0.join("missing.txt")).unwrap(), None);
        assert!(read_chunk(&dir.0.join("missing.txt"), 0, 1024, None).is_err());
        assert!(read_chunk(&dir.0, 0, 1024, None).is_err());
    }

    #[test]
    fn saving_into_a_missing_folder_fails_without_creating_it() {
        let dir = TestDir::new();
        let path = dir.0.join("no such folder").join("a.txt");
        assert!(save(&request(&path, "x", Eol::Lf, Encoding::Utf8)).is_err());
        assert!(!dir.0.join("no such folder").exists());
    }

    #[test]
    fn a_long_single_line_is_cut_on_a_character_boundary() {
        let dir = TestDir::new();
        // No line break at all, two-byte characters, odd window.
        let text = "é".repeat(5000);
        let path = dir.file(text.as_bytes());
        let chunk = read_chunk(&path, 0, 4097, None).unwrap();
        assert_eq!((chunk.next_offset, chunk.eof), (4096, false));
        assert_eq!(walk(&path, 4097), text);
    }

    #[test]
    fn utf16_tail_save_keeps_the_rest_of_the_file() {
        let dir = TestDir::new();
        let original = utf16(&"سطر\n".repeat(50), LE);
        let path = dir.file(&original);
        let first = read_chunk(&path, 0, 32, None).unwrap();
        assert!(!first.eof);
        let mut req = request(&path, &format!("NEW{}", first.text), Eol::Lf, LE);
        req.tail_offset = Some(first.next_offset);
        req.expected_stamp = Some(first.stamp);
        save(&req).unwrap();
        assert_eq!(walk(&path, 1024), format!("NEW{}", "سطر\n".repeat(50)));
    }

    // BUGS.md H14: mixed line endings were all rewritten in the first line's style.
    #[test]
    fn mixed_line_endings_are_kept_on_save() {
        let dir = TestDir::new();
        let path = dir.file(b"a\r\nb\nc");
        let chunk = read_chunk(&path, 0, 1024, None).unwrap();
        save(&request(&path, &chunk.text, chunk.eol, chunk.encoding)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\nc");
    }

    #[test]
    fn mixed_line_endings_survive_added_and_edited_lines() {
        let dir = TestDir::new();
        let path = dir.file(b"a\r\nb\nc\r\nd");
        // A line inserted after "a" gets the first line's style; the rest keep theirs.
        save(&request(&path, "a\nX\nb\nc\nd", Eol::Crlf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nX\r\nb\nc\r\nd");
        // Edited in place, no lines added: every line keeps its own ending.
        save(&request(&path, "A\nX\nB\nc\nd", Eol::Crlf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"A\r\nX\r\nB\nc\r\nd");
        // A line ending chosen by the user is written everywhere.
        let mut normalize = request(&path, "A\nX\nB\nc\nd", Eol::Lf, Encoding::Utf8);
        normalize.normalize_eol = true;
        save(&normalize).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"A\nX\nB\nc\nd");
        // A file with one style is converted as before.
        save(&request(&path, "A\nX", Eol::Crlf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"A\r\nX");
    }

    #[test]
    fn mixed_line_endings_are_kept_in_a_tail_save() {
        let dir = TestDir::new();
        let path = dir.file(b"a\r\nb\nccc\r\nddd");
        let first = read_chunk(&path, 0, 6, None).unwrap();
        assert_eq!(
            (first.text.as_str(), first.next_offset, first.eof),
            ("a\nb\n", 5, false)
        );
        let mut req = request(&path, "A\nb\n", first.eol, first.encoding);
        req.tail_offset = Some(first.next_offset);
        req.expected_stamp = Some(first.stamp);
        save(&req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"A\r\nb\nccc\r\nddd");
    }

    #[test]
    fn split_lines_keeps_each_ending() {
        assert_eq!(
            split_lines("a\r\nb\nc\rd"),
            vec![
                ("a", Some("\r\n")),
                ("b", Some("\n")),
                ("c", Some("\r")),
                ("d", None)
            ]
        );
        assert_eq!(split_lines(""), vec![("", None)]);
        assert_eq!(split_lines("x\n"), vec![("x", Some("\n")), ("", None)]);
    }

    // BUGS.md M15: a UTF-16 file without a BOM was read as UTF-8.
    #[test]
    fn utf16_without_bom_is_detected() {
        let dir = TestDir::new();
        let path = dir.file(&encode_text("hello", Eol::Lf, LE));
        assert_eq!(read_chunk(&path, 0, 1024, None).unwrap().text, "hello");
        let chunk = read_chunk(
            &dir.file(&encode_text("hi\r\nthere", Eol::Crlf, BE)),
            0,
            1024,
            None,
        )
        .unwrap();
        assert_eq!(
            (chunk.text.as_str(), chunk.encoding, chunk.eol),
            ("hi\nthere", BE, Eol::Crlf)
        );
        // Ordinary text has no zero bytes and stays UTF-8.
        assert_eq!(
            detect_encoding("héllo wörld".as_bytes(), true),
            (Encoding::Utf8, 0)
        );
        // An odd number of bytes cannot be a whole UTF-16 file.
        assert_eq!(detect_encoding(b"a\0b", true), (Encoding::Utf8, 0));
    }

    // BUGS.md M15: a wrongly detected encoding could not be corrected.
    #[test]
    fn a_hint_at_offset_zero_reopens_the_file_with_that_encoding() {
        let dir = TestDir::new();
        let path = dir.file("é\nb".as_bytes());
        assert_eq!(
            read_chunk(&path, 0, 1024, None).unwrap().encoding,
            Encoding::Utf8
        );
        let ansi = read_chunk(&path, 0, 1024, Some(Encoding::Ansi)).unwrap();
        assert_eq!(ansi.encoding, Encoding::Ansi);
        assert_eq!(ansi.text, decode("é\nb".as_bytes(), Encoding::Ansi));

        let mut bom = BOM_UTF8.to_vec();
        bom.extend(b"hi");
        let chunk = read_chunk(&dir.file(&bom), 0, 1024, Some(Encoding::Utf8)).unwrap();
        assert_eq!(
            (chunk.text.as_str(), chunk.encoding),
            ("hi", Encoding::Utf8Bom)
        );

        let chunk = read_chunk(&dir.file(b"h\0i\0"), 0, 1024, Some(LE)).unwrap();
        assert_eq!((chunk.text.as_str(), chunk.next_offset), ("hi", 4));
    }

    // BUGS.md C7: bytes past the first 256 KB that are not UTF-8 must be noticed.
    #[test]
    fn scan_reports_bytes_the_encoding_cannot_decode() {
        let dir = TestDir::new();
        let mut bytes = "a\n".repeat(200_000).into_bytes();
        bytes.extend(b"caf\xE9\n");
        let path = dir.file(&bytes);
        assert_eq!(
            read_chunk(&path, 0, FIRST_CHUNK, None).unwrap().encoding,
            Encoding::Utf8
        );
        assert!(scan(&path, Encoding::Utf8).unwrap().invalid);
        if ansi_codec() == encoding_rs::WINDOWS_1252 {
            assert!(!scan(&path, Encoding::Ansi).unwrap().invalid);
        }
        assert!(!scan(&dir.file(b"plain"), Encoding::Utf8).unwrap().invalid);
    }

    // BUGS.md H15: the fallback for folders where no temp file can be created.
    #[test]
    fn writing_in_place_keeps_the_tail_and_trims_the_rest() {
        let dir = TestDir::new();
        let path = dir.file(b"HEAD-tail");
        let mut req = request(&path, "", Eol::Lf, Encoding::Utf8);
        req.tail_offset = Some(5);
        req.expected_stamp = stat(&path).unwrap();
        let stamp = write_in_place(&path, &req, b"much longer head-").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"much longer head-tail");
        assert_eq!(stat(&path).unwrap(), Some(stamp));

        let mut req = request(&path, "", Eol::Lf, Encoding::Utf8Bom);
        req.tail_offset = Some(17);
        let stamp = write_in_place(&path, &req, b"h-").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFh-tail");
        assert_eq!(stamp.size, 9);

        let mut stale = request(&path, "", Eol::Lf, Encoding::Utf8);
        stale.expected_stamp = Some(FileStamp {
            size: 1,
            mtime_ms: 0.0,
        });
        assert_eq!(write_in_place(&path, &stale, b"x").unwrap_err(), STALE);
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFh-tail");
        assert_eq!(dir.entries(), 1);
    }

    // BUGS.md W8: ReplaceFileW gets no long-path handling from std.
    #[test]
    fn long_paths_get_the_verbatim_prefix_for_replace_file() {
        let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        let long = "x".repeat(300);
        assert_eq!(long_path_prefix(&units(r"C:\short\a.txt")), ("", 0));
        assert_eq!(
            long_path_prefix(&units(&format!(r"C:\{long}\a.txt"))),
            (r"\\?\", 0)
        );
        assert_eq!(
            long_path_prefix(&units(&format!(r"\\server\share\{long}"))),
            (r"\\?\UNC\", 2)
        );
        assert_eq!(
            long_path_prefix(&units(&format!(r"\\?\C:\{long}"))),
            ("", 0)
        );
        assert_eq!(long_path_prefix(&units(&long)), ("", 0));

        let wide_path = wide(Path::new(&format!(r"C:/{long}/a.txt")));
        assert_eq!(wide_path, units(&format!("\\\\?\\C:\\{long}\\a.txt\0")));
        let wide_unc = wide(Path::new(&format!(r"\\server\share\{long}")));
        assert_eq!(
            wide_unc,
            units(&format!("\\\\?\\UNC\\server\\share\\{long}\0"))
        );
        assert_eq!(wide(Path::new(r"C:\a")), units("C:\\a\0"));
    }

    // BUGS.md FILES-1: the frontend could not tell a file has mixed line endings.
    #[test]
    fn chunks_report_mixed_line_endings() {
        let dir = TestDir::new();
        let mixed = read_chunk(&dir.file(b"a\r\nb\nc"), 0, 1024, None).unwrap();
        assert_eq!((mixed.eol, mixed.mixed_eol), (Eol::Crlf, true));
        let plain = read_chunk(&dir.file(b"a\r\nb\r\nc"), 0, 1024, None).unwrap();
        assert!(!plain.mixed_eol);
        let cr = read_chunk(&dir.file(b"a\rb\rc\r"), 0, 1024, None).unwrap();
        assert_eq!((cr.eol, cr.mixed_eol), (Eol::Cr, false));
        // A later chunk compares against the file's first line ending.
        let path = dir.file(b"first\r\nsecond\nthird\n");
        let later = read_chunk(&path, 7, 1024, Some(Encoding::Utf8)).unwrap();
        assert_eq!((later.eol, later.mixed_eol), (Eol::Crlf, true));
        // A CRLF is never counted as a CR and an LF.
        for window in 1..=24 {
            let path = dir.file(b"one\r\ntwo\r\nthree\r\nfour");
            let mut offset = 0;
            loop {
                let chunk = read_chunk(&path, offset, window, Some(Encoding::Utf8)).unwrap();
                assert!(!chunk.mixed_eol, "window {window} at {offset}");
                if chunk.eof {
                    break;
                }
                offset = chunk.next_offset;
            }
        }
        // UTF-16 too.
        let utf16_mixed =
            read_chunk(&dir.file(&raw_utf16("a\r\nb\nc", LE)), 0, 1024, None).unwrap();
        assert!(utf16_mixed.mixed_eol);
    }

    #[test]
    fn has_other_eol_looks_at_every_ending() {
        assert!(!has_other_eol("", Eol::Crlf));
        assert!(!has_other_eol("a\nb\n", Eol::Lf));
        assert!(has_other_eol("a\nb\r\n", Eol::Lf));
        assert!(has_other_eol("a\r\nb\r", Eol::Crlf));
        assert!(!has_other_eol("a\r\n\r\n", Eol::Crlf));
        assert!(has_other_eol("a\r\r\n", Eol::Cr));
    }

    // FILES-1: picking a line ending for a mixed file writes it everywhere.
    #[test]
    fn a_mixed_file_is_normalised_to_its_first_style_when_asked() {
        let dir = TestDir::new();
        let path = dir.file(b"a\r\nb\nc\r\n");
        let chunk = read_chunk(&path, 0, 1024, None).unwrap();
        assert!(chunk.mixed_eol);
        let mut req = request(&path, &chunk.text, chunk.eol, chunk.encoding);
        req.normalize_eol = true;
        save(&req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc\r\n");
        assert!(!read_chunk(&path, 0, 1024, None).unwrap().mixed_eol);
    }

    // Edge case "read-only file": Save said "Access is denied" with no sign before.
    #[test]
    fn the_first_chunk_reports_a_read_only_file() {
        let dir = TestDir::new();
        let path = dir.file(b"locked\nfile");
        assert!(!read_chunk(&path, 0, 1024, None).unwrap().read_only);
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms.clone()).unwrap();
        assert!(read_chunk(&path, 0, 1024, None).unwrap().read_only);
        // Later chunks do not pay for the check.
        assert!(
            !read_chunk(&path, 7, 1024, Some(Encoding::Utf8))
                .unwrap()
                .read_only
        );
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap();
    }

    // BUGS.md M15: no warning when a binary file is opened as text.
    #[test]
    fn nul_bytes_mark_a_chunk_as_binary() {
        let dir = TestDir::new();
        let exe = dir.file(b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xFF\xFF");
        assert!(read_chunk(&exe, 0, 1024, None).unwrap().binary);
        let text = dir.file("plain text, é and 😀\n".as_bytes());
        assert!(!read_chunk(&text, 0, 1024, None).unwrap().binary);
        // The zero bytes of UTF-16 text are not NUL characters.
        let wide = dir.file(&encode_text("hello world", Eol::Lf, LE));
        let chunk = read_chunk(&wide, 0, 1024, None).unwrap();
        assert_eq!((chunk.encoding, chunk.binary), (LE, false));
    }

    // BUGS.md M15: code pages other than a few were read as windows-1252.
    #[test]
    fn more_code_pages_have_a_codec() {
        let name = |cp| codec_for_code_page(cp).map(|c| c.name());
        assert_eq!(name(866), Some("IBM866"));
        assert_eq!(name(20866), Some("KOI8-R"));
        assert_eq!(name(21866), Some("KOI8-U"));
        assert_eq!(name(1251), Some("windows-1251"));
        assert_eq!(name(1258), Some("windows-1258"));
        assert_eq!(name(28595), Some("ISO-8859-5"));
        assert_eq!(name(54936), Some("gb18030"));
        assert_eq!(name(936), Some("GBK"));
        assert_eq!(name(10000), Some("macintosh"));
        // Not in encoding_rs: the caller falls back to windows-1252.
        assert_eq!(name(437), None);
        assert_eq!(name(850), None);
        assert_eq!(name(65001), None);
    }

    #[test]
    fn multibyte_cuts_know_gb18030_and_euc_jp_widths() {
        // A four-byte GB18030 character cut after its second byte.
        let gb = [b'a', 0x81, 0x30, 0x81, 0x30, b'b', 0x81, 0x30];
        assert_eq!(cut_ansi(&gb, encoding_rs::GB18030), 6);
        // A three-byte EUC-JP character (0x8F lead) cut after two bytes.
        let euc = [b'a', 0xA4, 0xA2, 0x8F, 0xA2];
        assert_eq!(cut_ansi(&euc, encoding_rs::EUC_JP), 3);
        assert_eq!(cut_ansi(&euc, encoding_rs::EUC_KR), 5);
    }

    // BUGS.md "Review: Rust backend": after an encoding change the old lines
    // were decoded with the new encoding, so mixed endings were not kept.
    #[test]
    fn mixed_line_endings_are_kept_across_an_encoding_change() {
        let dir = TestDir::new();
        let path = dir.file(&raw_utf16("a\r\nb\nc", LE));
        let chunk = read_chunk(&path, 0, 1024, None).unwrap();
        save(&request(&path, &chunk.text, chunk.eol, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\nc");

        // Told explicitly: an ANSI file saved as UTF-16.
        let path = dir.file(b"x\r\ny\nz");
        let mut req = request(&path, "x\ny\nz", Eol::Crlf, BE);
        req.original_encoding = Some(Encoding::Ansi);
        save(&req).unwrap();
        assert_eq!(fs::read(&path).unwrap(), raw_utf16("x\r\ny\nz", BE));
    }

    // BUGS.md RUST-7: two saves of one file could both pass the freshness check.
    #[test]
    fn concurrent_saves_with_the_same_stamp_let_only_one_win() {
        let dir = TestDir::new();
        let path = dir.file(b"original");
        for round in 0..20 {
            // Each round starts from a file with a known stamp.
            fs::write(&path, format!("round {round} start")).unwrap();
            let stamp = stat(&path).unwrap();
            let results: Vec<Result<FileStamp, String>> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..4)
                    .map(|i| {
                        let path = path.clone();
                        scope.spawn(move || {
                            let mut req = request(
                                &path,
                                &format!("writer {i} {}", "x".repeat(i)),
                                Eol::Lf,
                                Encoding::Utf8,
                            );
                            req.expected_stamp = stamp;
                            save(&req)
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap()).collect()
            });
            let wins = results.iter().filter(|r| r.is_ok()).count();
            assert_eq!(wins, 1, "round {round}: {results:?}");
            assert!(results
                .iter()
                .all(|r| r.as_ref().is_ok() || r.as_ref().unwrap_err() == STALE));
        }
        assert_eq!(dir.entries(), 1, "temp file left behind");
    }

    // BUGS.md RUST-4: a file opened through an alternate data stream.
    #[test]
    fn stream_paths_are_recognised() {
        assert!(is_stream_path(Path::new("notes.txt:secret")));
        assert!(is_stream_path(Path::new("notes.txt::$DATA")));
        assert!(!is_stream_path(Path::new("notes.txt")));
        #[cfg(windows)]
        {
            assert!(is_stream_path(Path::new(r"C:\notes\notes.txt:secret")));
            assert!(!is_stream_path(Path::new(r"C:\notes\notes.txt")));
            assert!(!is_stream_path(Path::new(r"C:notes.txt")));
            assert!(!is_stream_path(Path::new(r"\\server\share\a.txt")));
        }
    }

    #[cfg(windows)]
    #[test]
    fn saving_into_an_alternate_data_stream_writes_the_stream() {
        let dir = TestDir::new();
        let path = dir.file(b"main data");
        let stream = PathBuf::from(format!("{}:secret", path.display()));
        // A new stream is created; the main data is untouched.
        save(&request(&stream, "hidden\ntext", Eol::Crlf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&stream).unwrap(), b"hidden\r\ntext");
        assert_eq!(fs::read(&path).unwrap(), b"main data");
        // An existing stream is rewritten, shorter, with a stamp check.
        let mut req = request(&stream, "short", Eol::Lf, Encoding::Utf8);
        req.expected_stamp = stat(&stream).unwrap();
        save(&req).unwrap();
        assert_eq!(fs::read(&stream).unwrap(), b"short");
        assert_eq!(fs::read(&path).unwrap(), b"main data");
        assert_eq!(dir.entries(), 1, "temp file left behind");
    }

    // BUGS.md "Review: Rust backend": a save broke hard links.
    #[test]
    fn a_hard_linked_file_is_written_in_place() {
        let dir = TestDir::new();
        let path = dir.file(b"shared text");
        let other = dir.0.join("other name.txt");
        fs::hard_link(&path, &other).unwrap();
        assert!(must_write_in_place(&path));
        save(&request(&path, "new\ntext", Eol::Crlf, Encoding::Utf8)).unwrap();
        assert_eq!(fs::read(&other).unwrap(), b"new\r\ntext");
        assert_eq!(fs::read(&path).unwrap(), b"new\r\ntext");
        assert_eq!(dir.entries(), 2, "temp file left behind");
        fs::remove_file(&other).unwrap();
        assert!(!must_write_in_place(&path));
    }

    #[test]
    fn only_old_temp_files_of_dead_processes_are_cleaned_up() {
        assert_eq!(stale_temp_pid("~notepadly-123-4.tmp"), Some(123));
        assert_eq!(stale_temp_pid("~notepadly-123-4.recovered.txt"), None);
        assert_eq!(stale_temp_pid("~notepadly-123.tmp"), None);
        assert_eq!(stale_temp_pid("~notepadly--4.tmp"), None);
        assert_eq!(stale_temp_pid("notes.tmp"), None);

        let dir = TestDir::new();
        // A pid that cannot be running (above the Windows and Linux maximum).
        let dead = dir.0.join("~notepadly-4294967290-1.tmp");
        let mine = dir
            .0
            .join(format!("~notepadly-{}-99.tmp", std::process::id()));
        let kept = dir.0.join("~notepadly-4294967290-2.recovered.txt");
        let user = dir.0.join("~notepadly-notes.tmp");
        for path in [&dead, &mine, &kept, &user] {
            fs::write(path, b"x").unwrap();
        }
        // A fresh crash leftover stays a day.
        remove_stale_temps(&dir.0, SystemTime::now());
        assert!(dead.exists());
        let tomorrow = SystemTime::now() + STALE_TEMP_AGE + Duration::from_secs(60);
        remove_stale_temps(&dir.0, tomorrow);
        assert!(!dead.exists());
        assert!(mine.exists() && kept.exists() && user.exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_broken_symlink_is_saved_where_it_points() {
        use std::os::windows::fs::symlink_file;
        let dir = TestDir::new();
        let link = dir.0.join("link.txt");
        // Creating symlinks needs Developer Mode or admin rights on Windows.
        if symlink_file("target.txt", &link).is_err() {
            return;
        }
        save(&request(&link, "through the link", Eol::Lf, Encoding::Utf8)).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(dir.0.join("target.txt")).unwrap(),
            b"through the link"
        );
    }
}
