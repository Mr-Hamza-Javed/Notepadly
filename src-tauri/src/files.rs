//! Lock-free file I/O. Every call opens, works, and closes: no handle outlives
//! a command, and every open allows other programs to read, write and delete.

use encoding_rs::CoderResult;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use windows_sys::Win32::Globalization::GetACP;
use windows_sys::Win32::Storage::FileSystem::{
    ReplaceFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS,
};

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

/// The literal error the frontend matches on.
const STALE: &str = "STALE";

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
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileScan {
    pub chars: u64,
    pub lines: u64,
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
        let cp = unsafe { GetACP() };
        match cp {
            874 => encoding_rs::WINDOWS_874,
            932 => encoding_rs::SHIFT_JIS,
            936 => encoding_rs::GBK,
            949 => encoding_rs::EUC_KR,
            950 => encoding_rs::BIG5,
            1250..=1258 => encoding_rs::Encoding::for_label(format!("windows-{cp}").as_bytes())
                .unwrap_or(encoding_rs::WINDOWS_1252),
            _ => encoding_rs::WINDOWS_1252,
        }
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
    match std::str::from_utf8(head) {
        Ok(_) => (Encoding::Utf8, 0),
        // A sequence cut off by the end of the window is still valid UTF-8.
        Err(e) if e.error_len().is_none() && !complete => (Encoding::Utf8, 0),
        Err(_) => (Encoding::Ansi, 0),
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
    let lead: fn(u8) -> bool = if codec == encoding_rs::SHIFT_JIS {
        |b| matches!(b, 0x81..=0x9F | 0xE0..=0xFC)
    } else {
        |b| matches!(b, 0x81..=0xFE)
    };
    cut_bytes(body, |bytes| dbcs_char_cut(bytes, lead))
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

/// Double-byte trail bytes overlap ASCII, so only a walk from the known
/// character boundary at the start of the window is reliable.
fn dbcs_char_cut(bytes: &[u8], is_lead: fn(u8) -> bool) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        let width = if is_lead(bytes[i]) { 2 } else { 1 };
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
        let (encoding, bom_len) = detect_encoding(&window, eof);
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
    let text = match normalize_newlines(&decode(&body[..cut], encoding)) {
        Cow::Borrowed(s) => s.to_owned(),
        Cow::Owned(s) => s,
    };

    Ok(FileChunk {
        text,
        next_offset: offset + (bom_len + cut) as u64,
        eof,
        encoding,
        eol: known_eol.unwrap_or(Eol::Crlf),
        stamp,
    })
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
    let mut result = FileScan { chars: 0, lines: 1 };
    let mut after_cr = false;
    loop {
        let read = file.read(&mut input).map_err(err)?;
        let last = read == 0;
        let mut consumed = 0;
        loop {
            let (status, used, written, _) =
                decoder.decode_to_utf16(&input[consumed..read], &mut output, last);
            consumed += used;
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

fn encode_text(text: &str, eol: Eol, encoding: Encoding) -> Vec<u8> {
    let normalized = normalize_newlines(text);
    let converted = match eol {
        Eol::Lf => normalized,
        Eol::Crlf => Cow::Owned(normalized.replace('\n', "\r\n")),
        Eol::Cr => Cow::Owned(normalized.replace('\n', "\r")),
    };
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => converted.into_owned().into_bytes(),
        Encoding::Utf16Le => converted
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect(),
        Encoding::Utf16Be => converted
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect(),
        Encoding::Ansi => encode_ansi(&converted),
    }
}

/// Characters the code page cannot represent become `?`, as Notepad does.
fn encode_ansi(text: &str) -> Vec<u8> {
    let mut encoder = ansi_codec().new_encoder();
    let mut out = Vec::with_capacity(text.len());
    let mut rest = text;
    loop {
        let (status, read) =
            encoder.encode_from_utf8_to_vec_without_replacement(rest, &mut out, true);
        rest = &rest[read..];
        match status {
            encoding_rs::EncoderResult::InputEmpty => return out,
            encoding_rs::EncoderResult::OutputFull => out.reserve(rest.len().max(16)),
            encoding_rs::EncoderResult::Unmappable(_) => out.push(b'?'),
        }
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

fn wide(path: &Path) -> Vec<u16> {
    OsStr::new(path).encode_wide().chain(Some(0)).collect()
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

fn append_tail(target: &Path, offset: u64, output: &mut File) -> Result<(), String> {
    let mut source = open_shared(target).map_err(err)?;
    if offset > source.metadata().map_err(err)?.len() {
        return Err(STALE.to_owned());
    }
    source.seek(SeekFrom::Start(offset)).map_err(err)?;
    io::copy(&mut source, output).map_err(err)?;
    Ok(())
}

/// A rename would turn a symlink into a regular file, so save through it instead.
fn resolve_target(path: &Path) -> PathBuf {
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if is_link {
        fs::canonicalize(path).unwrap_or_else(|_| path.to_owned())
    } else {
        path.to_owned()
    }
}

pub fn save(req: &SaveRequest) -> Result<FileStamp, String> {
    let target = resolve_target(Path::new(&req.path));
    ensure_fresh(&target, req.expected_stamp)?;

    let bytes = encode_text(&req.text, req.eol, req.encoding);
    let (mut temp, mut output) = TempFile::create(&target).map_err(err)?;
    output.write_all(req.encoding.bom()).map_err(err)?;
    output.write_all(&bytes).map_err(err)?;
    drop(bytes);
    if let Some(offset) = req.tail_offset {
        append_tail(&target, offset, &mut output)?;
    }
    output.sync_all().map_err(err)?;
    drop(output);

    // The file may have changed while the tail was being copied.
    ensure_fresh(&target, req.expected_stamp)?;
    commit(&mut temp, &target)?;
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
        let lead: fn(u8) -> bool = |b| matches!(b, 0x81..=0x9F | 0xE0..=0xFC);
        assert_eq!(dbcs_char_cut(&bytes, lead), 3);
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
        }
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

        save(&request(&path, "caf\u{e9}", Eol::Lf, Encoding::Ansi)).unwrap();
        if ansi_codec().is_single_byte() && ansi_codec() == encoding_rs::WINDOWS_1252 {
            assert_eq!(fs::read(&path).unwrap(), b"caf\xE9");
            let chunk = read_chunk(&path, 0, 1024, None).unwrap();
            assert_eq!(
                (chunk.text.as_str(), chunk.encoding),
                ("caf\u{e9}", Encoding::Ansi)
            );
            save(&request(&path, "x\u{4E2D}y", Eol::Lf, Encoding::Ansi)).unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"x?y");
        }
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
            FileScan { chars: 0, lines: 1 }
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
        };
        let value = serde_json::to_value(&chunk).unwrap();
        assert_eq!(value["nextOffset"], 3);
        assert_eq!(value["stamp"]["mtimeMs"], 2.0);
    }
}
