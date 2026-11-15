//! Drafts and session, stored under the app data dir.

use crate::files::open_shared;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SESSION_FILE: &str = "session.json";
const DRAFTS_DIR: &str = "drafts";
const RESERVED_NAMES: &[&str] = &["CON", "PRN", "AUX", "NUL"];

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

/// Ids are a single path component of `[A-Za-z0-9_-]`, so a hostile or corrupt
/// id cannot leave the drafts folder or name a Windows device.
fn draft_path(base: &Path, id: &str) -> Result<PathBuf, String> {
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
    Ok(base.join(DRAFTS_DIR).join(format!("{id}.txt")))
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

/// A crash mid-write must not destroy the previous draft or session.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("tmp");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
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
        for ok in ["CONSOLE", "nul_1", "COM", "LPT10", "t-con"] {
            assert!(draft_path(base, ok).is_ok(), "{ok}");
        }
        assert!(
            draft_path(base, "تب").is_err(),
            "non-ASCII ids are rejected"
        );
        assert!(draft_path(base, "a b").is_err());
    }

    #[test]
    fn deleting_a_draft_with_a_bad_id_is_refused_and_touches_nothing() {
        let base = TempBase::new("baddelete");
        session_write(&base.0, "keep").unwrap();
        assert!(draft_delete(&base.0, "../session").is_err());
        assert_eq!(session_read(&base.0).unwrap().as_deref(), Some("keep"));
    }
}
