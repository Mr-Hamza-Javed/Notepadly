//! Drafts and session, stored under the app data dir.

use crate::files::open_shared;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

const SESSION_FILE: &str = "session.json";
const DRAFTS_DIR: &str = "drafts";
/// One session file per window that is open (or waiting in the background).
const SESSIONS_DIR: &str = "sessions";
const RESERVED_NAMES: &[&str] = &["CON", "PRN", "AUX", "NUL"];
/// A draft or temp file changed this recently may belong to a window that is
/// writing it right now, so the clean-up leaves it alone.
const PRUNE_GRACE: Duration = Duration::from_secs(60);

/// When this process started (first call wins; `lib.rs` calls it at launch).
pub fn process_start() -> SystemTime {
    static START: OnceLock<SystemTime> = OnceLock::new();
    *START.get_or_init(SystemTime::now)
}

pub fn session_read(base: &Path) -> Result<Option<String>, String> {
    read_optional(&base.join(SESSION_FILE))
}

pub fn session_write(base: &Path, json: &str) -> Result<(), String> {
    write_atomic(&base.join(SESSION_FILE), json)
}

pub fn draft_read(base: &Path, id: &str) -> Result<Option<String>, String> {
    read_optional(&draft_path(base, id)?)
}

pub fn draft_write(base: &Path, id: &str, text: &str) -> Result<(), String> {
    write_atomic(&draft_path(base, id)?, text)
}

pub fn draft_delete(base: &Path, id: &str) -> Result<(), String> {
    match fs::remove_file(draft_path(base, id)?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The stored session of every window, as (key, json) pairs. A file that cannot
/// be read is left out rather than failing the whole list.
pub fn window_sessions_read(base: &Path) -> Result<Vec<(String, String)>, String> {
    let entries = match fs::read_dir(base.join(SESSIONS_DIR)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(key) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if check_id(key).is_err() {
            continue;
        }
        if let Ok(Some(json)) = read_optional(&path) {
            sessions.push((key.to_owned(), json));
        }
    }
    sessions.sort();
    Ok(sessions)
}

pub fn window_session_write(base: &Path, key: &str, json: &str) -> Result<(), String> {
    write_atomic(&window_session_path(base, key)?, json)
}

pub fn window_session_delete(base: &Path, key: &str) -> Result<(), String> {
    match fs::remove_file(window_session_path(base, key)?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn window_session_path(base: &Path, key: &str) -> Result<PathBuf, String> {
    check_id(key).map_err(|_| format!("invalid session key: {key:?}"))?;
    Ok(base.join(SESSIONS_DIR).join(format!("{key}.json")))
}

/// Deletes every draft whose id is not in `keep`, and temp files left by an
/// interrupted write. Drafts orphaned by a crash or a corrupt session would
/// otherwise stay forever. Files that cannot be removed are left for next time.
///
/// Only files from before this run are drafts of a past session: a draft
/// written since the app started belongs to a window of this run that may not
/// have stored its session yet (MERGE-1), and a temp file younger than a minute
/// may be a write in progress in another window.
pub fn drafts_prune(base: &Path, keep: &[String]) -> Result<(), String> {
    let now = SystemTime::now();
    let recent = now.checked_sub(PRUNE_GRACE).unwrap_or(now);
    drafts_prune_before(base, keep, process_start().min(recent), recent)
}

/// `drafts_prune` with explicit cut-offs: drafts modified at or after
/// `drafts_cutoff`, and temp files at or after `temp_cutoff`, are kept.
fn drafts_prune_before(
    base: &Path,
    keep: &[String],
    drafts_cutoff: SystemTime,
    temp_cutoff: SystemTime,
) -> Result<(), String> {
    let entries = match fs::read_dir(base.join(DRAFTS_DIR)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let older_than = |cutoff: SystemTime| {
            entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|modified| modified < cutoff)
        };
        let orphan = match path.extension().and_then(|e| e.to_str()) {
            Some("txt") => !keep.iter().any(|id| id == stem) && older_than(drafts_cutoff),
            Some("tmp") => older_than(temp_cutoff),
            _ => false,
        };
        if orphan {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Ids are a single path component of `[A-Za-z0-9_-]`, so a hostile or corrupt
/// id cannot leave the drafts folder or name a Windows device.
fn draft_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(base.join(DRAFTS_DIR).join(format!("{id}.txt")))
}

/// Ids are a single path component of `[A-Za-z0-9_-]`, so a hostile or corrupt
/// id cannot leave its folder or name a Windows device.
fn check_id(id: &str) -> Result<(), String> {
    let safe_chars = id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let upper = id.to_ascii_uppercase();
    let device = RESERVED_NAMES.contains(&upper.as_str())
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    if id.is_empty() || id.len() > 128 || !safe_chars || device {
        return Err(format!("invalid draft id: {id:?}"));
    }
    Ok(())
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    let mut file = match open_shared(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

/// A temp name of its own for each write (`<name>.<pid>-<n>.tmp`), so two writes
/// of one draft or session at once (two windows, or two processes) never share
/// a temp file and interleave.
fn unique_temp(path: &Path) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    path.with_file_name(format!("{stem}.{}-{seq}.tmp", std::process::id()))
}

/// A crash mid-write must not destroy the previous draft or session.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temp = unique_temp(path);
    // Flushed before the rename: NTFS journals the rename but not the data, so
    // after a power cut an unflushed temp file can replace the old draft with
    // zeros or nothing.
    let written = fs::File::create(&temp).and_then(|mut file| {
        file.write_all(text.as_bytes())?;
        file.sync_all()
    });
    written.map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_and_devices() {
        let base = Path::new("base");
        for bad in [
            "", "..", "../x", "a/b", r"a\b", "C:evil", "a.b", "NUL", "com1", "LPT9",
        ] {
            assert!(draft_path(base, bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(
            draft_path(base, "tab-12_a").unwrap(),
            base.join("drafts").join("tab-12_a.txt")
        );
    }

    #[test]
    fn drafts_and_session_round_trip() {
        let base = std::env::temp_dir().join(format!("notepadly-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        assert_eq!(session_read(&base).unwrap(), None);
        session_write(&base, "{\"a\":1}").unwrap();
        assert_eq!(session_read(&base).unwrap().as_deref(), Some("{\"a\":1}"));

        assert_eq!(draft_read(&base, "t1").unwrap(), None);
        draft_write(&base, "t1", "hello\nüñí").unwrap();
        assert_eq!(
            draft_read(&base, "t1").unwrap().as_deref(),
            Some("hello\nüñí")
        );
        draft_delete(&base, "t1").unwrap();
        draft_delete(&base, "t1").unwrap();
        assert_eq!(draft_read(&base, "t1").unwrap(), None);
        fs::remove_dir_all(&base).unwrap();
    }

    struct TempBase(PathBuf);

    impl TempBase {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("notepadly-store-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for TempBase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rewriting_replaces_the_old_content_and_leaves_no_temp_file() {
        let base = TempBase::new("rewrite");
        session_write(&base.0, "{\"v\":1,\"tabs\":[1,2,3]}").unwrap();
        session_write(&base.0, "{}").unwrap();
        assert_eq!(session_read(&base.0).unwrap().as_deref(), Some("{}"));
        draft_write(&base.0, "t", "a much longer first draft").unwrap();
        draft_write(&base.0, "t", "short").unwrap();
        assert_eq!(draft_read(&base.0, "t").unwrap().as_deref(), Some("short"));
        let names: Vec<_> = fs::read_dir(base.0.join("drafts"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["t.txt"]);
        assert!(!base.0.join("session.tmp").exists());
    }

    #[test]
    fn drafts_keep_unicode_crlf_and_empty_text_exactly() {
        let base = TempBase::new("exact");
        for text in [
            "",
            "سلام\r\nدنیا 😀",
            "\u{FEFF}starts with a BOM",
            "tab\there",
        ] {
            draft_write(&base.0, "d", text).unwrap();
            assert_eq!(draft_read(&base.0, "d").unwrap().as_deref(), Some(text));
        }
    }

    fn age(path: &Path, by: Duration) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - by).unwrap();
    }

    #[test]
    fn pruning_keeps_listed_drafts_and_removes_the_rest() {
        let base = TempBase::new("prune");
        assert_eq!(drafts_prune(&base.0, &[]), Ok(()));
        draft_write(&base.0, "keep", "kept").unwrap();
        draft_write(&base.0, "orphan", "old").unwrap();
        fs::write(base.0.join("drafts").join("keep.tmp"), "half").unwrap();
        fs::write(base.0.join("drafts").join("notes.md"), "not ours").unwrap();
        let hour = Duration::from_secs(3600);
        for name in ["keep.txt", "orphan.txt", "keep.tmp", "notes.md"] {
            age(&base.0.join("drafts").join(name), hour);
        }
        drafts_prune(&base.0, &["keep".to_string()]).unwrap();
        let mut names: Vec<_> = fs::read_dir(base.0.join("drafts"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["keep.txt", "notes.md"]);
        assert_eq!(
            draft_read(&base.0, "keep").unwrap().as_deref(),
            Some("kept")
        );
    }

    #[test]
    fn a_corrupt_draft_is_an_error_not_garbage() {
        let base = TempBase::new("corrupt");
        fs::create_dir_all(base.0.join("drafts")).unwrap();
        fs::write(
            base.0.join("drafts").join("bad.txt"),
            [0xFF, 0xFE, 0x00, 0xD8],
        )
        .unwrap();
        assert!(draft_read(&base.0, "bad").is_err());
    }

    #[test]
    fn draft_ids_have_a_length_limit_and_reject_every_device_name() {
        let base = Path::new("base");
        assert!(draft_path(base, &"a".repeat(128)).is_ok());
        assert!(draft_path(base, &"a".repeat(129)).is_err());
        for device in ["CON", "prn", "Aux", "nul", "COM9", "lpt1"] {
            assert!(draft_path(base, device).is_err(), "{device}");
        }
        // Names that merely start like a device are fine.
        for ok in ["CONSOLE", "nul_1", "COM", "LPT10", "COMX", "lpt_", "t-con"] {
            assert!(draft_path(base, ok).is_ok(), "{ok}");
        }
        assert!(
            draft_path(base, "تب").is_err(),
            "non-ASCII ids are rejected"
        );
        assert!(draft_path(base, "a b").is_err());
    }

    #[test]
    fn window_sessions_are_listed_written_and_deleted_by_key() {
        let base = TempBase::new("windows");
        assert!(window_sessions_read(&base.0).unwrap().is_empty());
        window_session_write(&base.0, "wb", "{\"b\":1}").unwrap();
        window_session_write(&base.0, "wa", "{\"a\":1}").unwrap();
        // Stray files in the folder are ignored.
        fs::write(base.0.join("sessions").join("wa.tmp"), "half").unwrap();
        fs::write(base.0.join("sessions").join("bad name.json"), "x").unwrap();
        assert_eq!(
            window_sessions_read(&base.0).unwrap(),
            vec![
                ("wa".to_owned(), "{\"a\":1}".to_owned()),
                ("wb".to_owned(), "{\"b\":1}".to_owned())
            ]
        );
        window_session_delete(&base.0, "wa").unwrap();
        window_session_delete(&base.0, "wa").unwrap();
        assert_eq!(window_sessions_read(&base.0).unwrap().len(), 1);
        assert!(window_session_write(&base.0, "../session", "x").is_err());
        assert!(window_session_delete(&base.0, "NUL").is_err());
    }

    #[test]
    fn deleting_a_draft_with_a_bad_id_is_refused_and_touches_nothing() {
        let base = TempBase::new("baddelete");
        session_write(&base.0, "keep").unwrap();
        assert!(draft_delete(&base.0, "../session").is_err());
        assert_eq!(session_read(&base.0).unwrap().as_deref(), Some("keep"));
    }

    // BUGS.md MERGE-1: a draft written by a window of this run before it stored
    // its session was deleted by the start-up clean-up.
    #[test]
    fn pruning_spares_drafts_from_this_run_and_temp_files_being_written() {
        let base = TempBase::new("prune-new");
        let drafts = base.0.join("drafts");
        draft_write(&base.0, "brand-new", "typed just now").unwrap();
        draft_write(&base.0, "old-orphan", "from a crash").unwrap();
        fs::write(drafts.join("brand-new.123-0.tmp"), "half").unwrap();
        fs::write(drafts.join("old.123-1.tmp"), "half").unwrap();
        let day = Duration::from_secs(24 * 3600);
        age(&drafts.join("old-orphan.txt"), day);
        age(&drafts.join("old.123-1.tmp"), day);
        drafts_prune(&base.0, &[]).unwrap();
        let mut names: Vec<_> = fs::read_dir(&drafts)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["brand-new.123-0.tmp", "brand-new.txt"]);

        // A draft from before the start of this run but written within the last
        // minute (a window of another process) is kept too.
        let start = SystemTime::now() - day;
        drafts_prune_before(&base.0, &[], start, SystemTime::now() - PRUNE_GRACE).unwrap();
        assert!(drafts.join("brand-new.txt").exists());
        // Once both are older than the cut-offs, they go.
        let later = SystemTime::now() + PRUNE_GRACE;
        drafts_prune_before(&base.0, &[], later, later).unwrap();
        assert_eq!(fs::read_dir(&drafts).unwrap().count(), 0);
    }

    #[test]
    fn the_process_start_is_fixed_once() {
        let first = process_start();
        assert!(first <= SystemTime::now());
        assert_eq!(process_start(), first);
    }

    // BUGS.md "Review: Rust backend": every write of one draft used `<id>.tmp`.
    #[test]
    fn concurrent_writes_of_one_draft_never_share_a_temp_file() {
        let base = TempBase::new("concurrent");
        assert_ne!(
            unique_temp(&base.0.join("a.txt")),
            unique_temp(&base.0.join("a.txt"))
        );
        let texts: Vec<String> = (0..8).map(|i| format!("{i}").repeat(10_000 + i)).collect();
        std::thread::scope(|scope| {
            for text in &texts {
                let base = &base.0;
                scope.spawn(move || {
                    for _ in 0..10 {
                        // Losing a rename race to another writer is fine (Windows can
                        // refuse a rename onto a file being replaced); a mix is not.
                        let _ = draft_write(base, "shared", text);
                    }
                });
            }
        });
        let saved = draft_read(&base.0, "shared").unwrap().unwrap();
        assert!(texts.contains(&saved), "the draft is a mix of two writes");
        let names: Vec<_> = fs::read_dir(base.0.join("drafts"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["shared.txt"], "temp file left behind");
    }
}
