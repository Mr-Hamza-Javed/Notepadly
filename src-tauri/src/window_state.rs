//! What the backend knows about each window: paths waiting for it, what it boots
//! with, whether it is still booting or already closing, and which files it has
//! open. Plain data with no Tauri types, so the rules are unit-tested here.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long a new window counts as on screen while it boots hidden (it shows
/// itself after its first paint). Long enough for a slow PC, short enough that
/// a window whose page never loads does not block background mode for good.
const BOOT_GRACE: Duration = Duration::from_secs(30);

/// One window as the caller sees it right now: its label and whether it is visible.
pub type WindowView = (String, bool);

/// Per-window state shared by every command.
#[derive(Default)]
pub struct WindowPaths {
    next_id: AtomicU64,
    inner: Mutex<PathsInner>,
}

#[derive(Default)]
pub struct PathsInner {
    pub pending: HashMap<String, Vec<String>>,
    pub ready: HashSet<String>,
    /// What a new window starts with besides paths: a stored session to restore or
    /// a tab dragged in from another window.
    pub boot: HashMap<String, WindowBoot>,
    /// The window that last had the focus: a second launch with files goes there.
    focused: Option<String>,
    /// Windows created hidden that have not shown themselves yet (RUST-5), with
    /// when they were created.
    booting: HashMap<String, Instant>,
    /// Windows that have started to close (STATE-8).
    closing: HashSet<String>,
    /// The files each window has open, as `path_key`s (WIN-3).
    open: HashMap<String, HashSet<String>>,
}

#[derive(Default, Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBoot {
    /// Key of the stored window session this window takes over.
    pub restore: Option<String>,
    /// JSON of a tab moved here from another window (the frontend's TabTransfer).
    pub transfer: Option<String>,
}

impl PathsInner {
    /// A window is on screen when it is visible, or was created a moment ago and
    /// has not had the time to show itself. A visible window is done booting.
    fn on_screen(&mut self, label: &str, visible: bool, now: Instant) -> bool {
        if visible {
            self.booting.remove(label);
            return true;
        }
        self.booting
            .get(label)
            .is_some_and(|since| now.saturating_duration_since(*since) < BOOT_GRACE)
    }

    /// No window but `label` is on screen and staying.
    fn is_last(&mut self, label: &str, windows: &[WindowView], now: Instant) -> bool {
        windows.iter().all(|(other, visible)| {
            other == label || self.closing.contains(other) || !self.on_screen(other, *visible, now)
        })
    }
}

impl WindowPaths {
    pub fn lock(&self) -> MutexGuard<'_, PathsInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn store(&self, label: &str, paths: Vec<String>) {
        if !paths.is_empty() {
            self.lock()
                .pending
                .entry(label.to_owned())
                .or_default()
                .extend(paths);
        }
    }

    pub fn take(&self, label: &str) -> Vec<String> {
        let mut inner = self.lock();
        inner.ready.insert(label.to_owned());
        inner.pending.remove(label).unwrap_or_default()
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.lock().ready.contains(label)
    }

    pub fn forget(&self, label: &str) {
        let mut inner = self.lock();
        inner.pending.remove(label);
        inner.ready.remove(label);
        inner.boot.remove(label);
        inner.booting.remove(label);
        inner.closing.remove(label);
        inner.open.remove(label);
        if inner.focused.as_deref() == Some(label) {
            inner.focused = None;
        }
    }

    pub fn set_boot(&self, label: &str, boot: WindowBoot) {
        if boot != WindowBoot::default() {
            self.lock().boot.insert(label.to_owned(), boot);
        }
    }

    pub fn take_boot(&self, label: &str) -> WindowBoot {
        self.lock().boot.remove(label).unwrap_or_default()
    }

    pub fn set_focused(&self, label: &str) {
        self.lock().focused = Some(label.to_owned());
    }

    pub fn focused(&self) -> Option<String> {
        self.lock().focused.clone()
    }

    /// A label no window has: window-1, window-2, ...
    pub fn new_label(&self, taken: impl Fn(&str) -> bool) -> String {
        loop {
            let label = format!(
                "window-{}",
                self.next_id.fetch_add(1, Ordering::Relaxed) + 1
            );
            if !taken(&label) {
                return label;
            }
        }
    }

    /// A window was just created hidden; it counts as on screen until it shows
    /// itself (or `BOOT_GRACE` passes).
    pub fn mark_booting(&self, label: &str) {
        self.mark_booting_at(label, Instant::now());
    }

    fn mark_booting_at(&self, label: &str, when: Instant) {
        self.lock().booting.insert(label.to_owned(), when);
    }

    /// True when any window is on screen (visible or booting).
    pub fn any_on_screen(&self, windows: &[WindowView]) -> bool {
        let now = Instant::now();
        let mut inner = self.lock();
        windows
            .iter()
            .any(|(label, visible)| inner.on_screen(label, *visible, now))
    }

    /// True when no other window is on screen and staying, so closing `label`
    /// would otherwise end the app.
    pub fn is_last(&self, label: &str, windows: &[WindowView]) -> bool {
        self.lock().is_last(label, windows, Instant::now())
    }

    /// Marks `label` as closing and says whether it is the last window, in one
    /// step: of two windows closing at once, exactly one is the last (STATE-8).
    pub fn start_closing(&self, label: &str, windows: &[WindowView]) -> bool {
        let mut inner = self.lock();
        inner.closing.insert(label.to_owned());
        inner.is_last(label, windows, Instant::now())
    }

    /// The user cancelled the close (for example at "save changes?").
    pub fn cancel_closing(&self, label: &str) {
        self.lock().closing.remove(label);
    }

    /// The window went to the background: it is hidden, no longer closing, and
    /// has no files open.
    pub fn entered_background(&self, label: &str) {
        let mut inner = self.lock();
        inner.booting.remove(label);
        inner.closing.remove(label);
        inner.open.remove(label);
    }

    /// Replaces the list of files `label` has open.
    pub fn set_open_paths(&self, label: &str, paths: &[String]) {
        let keys: HashSet<String> = paths.iter().map(|p| path_key(p)).collect();
        let mut inner = self.lock();
        if keys.is_empty() {
            inner.open.remove(label);
        } else {
            inner.open.insert(label.to_owned(), keys);
        }
    }

    /// Another window that has `path` open and is on screen and staying.
    pub fn holder_of(&self, label: &str, path: &str, windows: &[WindowView]) -> Option<String> {
        let key = path_key(path);
        let now = Instant::now();
        let mut inner = self.lock();
        let mut candidates: Vec<&WindowView> = windows.iter().filter(|(l, _)| l != label).collect();
        // Same answer every time when two windows hold the file.
        candidates.sort();
        for (other, visible) in candidates {
            let holds = inner
                .open
                .get(other)
                .is_some_and(|keys| keys.contains(&key));
            if holds && !inner.closing.contains(other) && inner.on_screen(other, *visible, now) {
                return Some(other.clone());
            }
        }
        None
    }
}

/// What a second launch of the app does (F1, `on_second_instance`).
#[derive(Debug, PartialEq, Eq)]
pub enum SecondLaunch {
    /// No files: open a new window next to this one (on screen, last focused).
    NewWindowNear(String),
    /// Files go to this window on screen, which follows "Open files in": sent
    /// now when its page is ready (`send`), else kept for it to take at boot.
    FilesTo { label: String, send: bool },
    /// No window on screen: bring this one back. `wake` it from the background
    /// first; when its page is not `ready`, the files are kept for its boot and
    /// it shows itself, else they are sent to open here and it is shown.
    Bring {
        label: String,
        wake: bool,
        ready: bool,
    },
    /// There is no window at all.
    Nothing,
}

impl WindowPaths {
    /// Where a second launch goes. `windows` in the app's order; `main` is the
    /// first window's label. A window on screen means a visible one: the
    /// focused one, else `main`, else the first.
    pub fn route_second_launch(
        &self,
        windows: &[WindowView],
        main: &str,
        has_paths: bool,
    ) -> SecondLaunch {
        let visible = |label: &str| windows.iter().any(|(l, v)| l == label && *v);
        let focused = self
            .focused()
            .filter(|label| visible(label))
            .or_else(|| visible(main).then(|| main.to_owned()))
            .or_else(|| windows.iter().find(|(_, v)| *v).map(|(l, _)| l.clone()));
        if let Some(label) = focused {
            if !has_paths {
                return SecondLaunch::NewWindowNear(label);
            }
            let send = self.is_ready(&label);
            return SecondLaunch::FilesTo { label, send };
        }
        let Some((label, visible)) = windows
            .iter()
            .find(|(l, _)| l == main)
            .or_else(|| windows.first())
        else {
            return SecondLaunch::Nothing;
        };
        let ready = self.is_ready(label);
        SecondLaunch::Bring {
            label: label.clone(),
            wake: !visible && ready,
            ready,
        }
    }

    /// Records what a window about to be created needs: its paths, its boot
    /// data, and that it counts as on screen while it boots hidden (RUST-5).
    /// `forget` undoes all of it when the window cannot be built.
    pub fn prepare_window(&self, label: &str, paths: Vec<String>, boot: WindowBoot) {
        self.store(label, paths);
        self.set_boot(label, boot);
        self.mark_booting(label);
    }
}

/// A Windows path in a form where two spellings of one file compare equal:
/// `/` as `\`, no `\\?\` prefix, `.` and `..` resolved, trailing dots and
/// spaces dropped from each name (Windows ignores them), and lower case. Purely
/// textual, so it never touches the disk; 8.3 names, links and mapped drives
/// are not resolved.
pub fn path_key(path: &str) -> String {
    let mut path = path.replace('/', "\\");
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        path = format!(r"\\{rest}");
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        path = rest.to_owned();
    }
    let (prefix, rest) = if let Some(unc) = path.strip_prefix(r"\\") {
        // \\server\share is the root of a network path.
        let mut parts = unc.splitn(3, '\\');
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        (
            format!(r"\\{server}\{share}"),
            parts.next().unwrap_or("").to_owned(),
        )
    } else if path.len() >= 2 && path.as_bytes()[1] == b':' {
        (path[..2].to_owned(), path[2..].to_owned())
    } else {
        (String::new(), path)
    };
    let mut names: Vec<&str> = Vec::new();
    for name in rest.split('\\') {
        match name {
            "" | "." => {}
            ".." => {
                names.pop();
            }
            name => {
                let trimmed = name.trim_end_matches(['.', ' ']);
                names.push(if trimmed.is_empty() { name } else { trimmed });
            }
        }
    }
    format!("{prefix}\\{}", names.join("\\")).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn views(list: &[(&str, bool)]) -> Vec<WindowView> {
        list.iter().map(|(l, v)| (l.to_string(), *v)).collect()
    }

    #[test]
    fn a_second_launch_without_files_opens_a_window_next_to_the_focused_one() {
        let state = WindowPaths::default();
        let windows = views(&[("main", true), ("window-1", true), ("window-2", false)]);
        assert_eq!(
            state.route_second_launch(&windows, "main", false),
            SecondLaunch::NewWindowNear("main".into())
        );
        state.set_focused("window-1");
        assert_eq!(
            state.route_second_launch(&windows, "main", false),
            SecondLaunch::NewWindowNear("window-1".into())
        );
        // A hidden window that last had the focus is passed over.
        state.set_focused("window-2");
        assert_eq!(
            state.route_second_launch(&windows, "main", false),
            SecondLaunch::NewWindowNear("main".into())
        );
        let no_main = views(&[("main", false), ("window-3", true)]);
        assert_eq!(
            state.route_second_launch(&no_main, "main", false),
            SecondLaunch::NewWindowNear("window-3".into())
        );
    }

    #[test]
    fn a_second_launch_with_files_sends_them_or_keeps_them_for_a_booting_window() {
        let state = WindowPaths::default();
        let windows = views(&[("main", true)]);
        assert_eq!(
            state.route_second_launch(&windows, "main", true),
            SecondLaunch::FilesTo {
                label: "main".into(),
                send: false
            }
        );
        state.take("main");
        assert_eq!(
            state.route_second_launch(&windows, "main", true),
            SecondLaunch::FilesTo {
                label: "main".into(),
                send: true
            }
        );
    }

    #[test]
    fn a_second_launch_with_no_window_on_screen_brings_one_back() {
        let state = WindowPaths::default();
        // Waiting in the background, page ready: wake it, then send the files.
        let hidden = views(&[("window-1", false), ("main", false)]);
        state.take("main");
        assert_eq!(
            state.route_second_launch(&hidden, "main", true),
            SecondLaunch::Bring {
                label: "main".into(),
                wake: true,
                ready: true
            }
        );
        // Still booting (hidden until its first paint): keep the files for it.
        assert_eq!(
            state.route_second_launch(&views(&[("window-1", false)]), "main", false),
            SecondLaunch::Bring {
                label: "window-1".into(),
                wake: false,
                ready: false
            }
        );
        assert_eq!(
            state.route_second_launch(&[], "main", true),
            SecondLaunch::Nothing
        );
    }

    // BUGS.md "Review: Rust backend": open_window's clean-up when the window
    // cannot be built was untested.
    #[test]
    fn a_window_that_could_not_be_built_leaves_nothing_behind() {
        let state = WindowPaths::default();
        let boot = WindowBoot {
            restore: None,
            transfer: Some("{}".into()),
        };
        state.prepare_window("window-1", vec!["a.txt".into()], boot);
        let windows = views(&[("main", true), ("window-1", false)]);
        // While it boots it counts as on screen, so main is not the last window.
        assert!(!state.is_last("main", &windows));
        state.forget("window-1");
        assert!(state.is_last("main", &windows));
        assert!(!state.any_on_screen(&views(&[("window-1", false)])));
        assert_eq!(state.take_boot("window-1"), WindowBoot::default());
        assert!(state.take("window-1").is_empty());
    }

    #[test]
    fn a_closed_window_forgets_its_pending_paths() {
        let state = WindowPaths::default();
        state.store("window-1", vec!["a".into()]);
        state.forget("window-1");
        assert!(!state.is_ready("window-1"));
        assert!(state.take("window-1").is_empty());
        // Storing nothing does not create an entry.
        state.store("window-2", Vec::new());
        assert!(state.lock().pending.is_empty());
    }

    #[test]
    fn window_boot_is_taken_once_and_forgotten_with_the_window() {
        let state = WindowPaths::default();
        let boot = WindowBoot {
            restore: Some("w1".into()),
            transfer: None,
        };
        state.set_boot("window-1", boot.clone());
        state.set_boot("window-2", WindowBoot::default());
        assert!(!state.lock().boot.contains_key("window-2"));
        assert_eq!(state.take_boot("window-1"), boot);
        assert_eq!(state.take_boot("window-1"), WindowBoot::default());
        state.set_boot("window-3", boot);
        state.set_focused("window-3");
        state.forget("window-3");
        assert_eq!(state.take_boot("window-3"), WindowBoot::default());
        assert_eq!(state.focused(), None);
    }

    #[test]
    fn new_labels_skip_windows_that_exist() {
        let state = WindowPaths::default();
        assert_eq!(
            state.new_label(|l| l == "window-1" || l == "window-2"),
            "window-3"
        );
        assert_eq!(state.new_label(|_| false), "window-4");
    }

    #[test]
    fn pending_paths_drain_once_per_label() {
        let state = WindowPaths::default();
        state.store("main", vec!["a".into()]);
        state.store("window-1", vec!["b".into()]);
        assert!(!state.is_ready("main"));
        assert_eq!(state.take("main"), ["a"]);
        assert!(state.is_ready("main"));
        assert!(state.take("main").is_empty());
        assert_eq!(state.take("window-1"), ["b"]);
    }

    // BUGS.md RUST-5: a window that had not painted yet did not count, so the
    // window closing next to it went to the background too.
    #[test]
    fn a_booting_window_counts_as_on_screen() {
        let state = WindowPaths::default();
        state.mark_booting("window-1");
        let windows = views(&[("main", true), ("window-1", false)]);
        assert!(!state.is_last("main", &windows));
        assert!(state.any_on_screen(&views(&[("main", false), ("window-1", false)])));
        // Once it has shown itself it is an ordinary window: hidden later (in the
        // background) it no longer counts.
        assert!(!state.is_last("main", &views(&[("main", true), ("window-1", true)])));
        assert!(state.is_last("main", &windows));
        assert!(!state.any_on_screen(&views(&[("main", false), ("window-1", false)])));
    }

    #[test]
    fn a_window_that_never_shows_stops_counting_after_a_while() {
        let state = WindowPaths::default();
        let long_ago = Instant::now()
            .checked_sub(BOOT_GRACE + Duration::from_secs(1))
            .unwrap();
        state.mark_booting_at("window-1", long_ago);
        assert!(state.is_last("main", &views(&[("main", true), ("window-1", false)])));
        // Going to the background or closing ends booting too.
        state.mark_booting("window-2");
        state.entered_background("window-2");
        assert!(!state.any_on_screen(&views(&[("window-2", false)])));
        state.mark_booting("window-3");
        state.forget("window-3");
        assert!(!state.any_on_screen(&views(&[("window-3", false)])));
    }

    // BUGS.md STATE-8: two windows closing at once both thought another stayed.
    #[test]
    fn of_two_windows_closing_at_once_exactly_one_is_the_last() {
        let state = WindowPaths::default();
        let windows = views(&[("main", true), ("window-1", true)]);
        assert!(!state.start_closing("main", &windows));
        assert!(state.start_closing("window-1", &windows));
        // Concurrently, from many threads: exactly one answer is "last".
        for _ in 0..50 {
            let state = WindowPaths::default();
            let labels: Vec<String> = (0..6).map(|i| format!("w{i}")).collect();
            let windows: Vec<WindowView> = labels.iter().map(|l| (l.clone(), true)).collect();
            let lasts = std::thread::scope(|scope| {
                let handles: Vec<_> = labels
                    .iter()
                    .map(|l| scope.spawn(|| state.start_closing(l, &windows)))
                    .collect();
                handles
                    .into_iter()
                    .map(|h| h.join().unwrap())
                    .filter(|last| *last)
                    .count()
            });
            assert_eq!(lasts, 1);
        }
    }

    #[test]
    fn a_cancelled_close_makes_the_window_count_again() {
        let state = WindowPaths::default();
        let windows = views(&[("main", true), ("window-1", true)]);
        assert!(!state.start_closing("main", &windows));
        state.cancel_closing("main");
        assert!(!state.start_closing("window-1", &windows));
        // A window that went to the background is no longer closing either.
        let state = WindowPaths::default();
        state.start_closing("main", &windows);
        state.entered_background("main");
        assert!(!state.is_last("window-1", &windows));
        // A closing window is not counted by is_last.
        state.start_closing("main", &windows);
        assert!(state.is_last("window-1", &windows));
    }

    // BUGS.md WIN-3: a file open in one window could be opened again in another.
    #[test]
    fn a_file_open_in_another_window_is_found() {
        let state = WindowPaths::default();
        let windows = views(&[("main", true), ("window-1", true), ("window-2", true)]);
        state.set_open_paths("window-1", &[r"C:\Notes\a.md".into(), r"C:\b.txt".into()]);
        assert_eq!(
            state
                .holder_of("main", "c:/notes/./x/../A.md", &windows)
                .as_deref(),
            Some("window-1")
        );
        // Not the asking window itself.
        assert_eq!(state.holder_of("window-1", r"C:\b.txt", &windows), None);
        assert_eq!(state.holder_of("main", r"C:\other.txt", &windows), None);
        // The list is replaced, not added to.
        state.set_open_paths("window-1", &[r"C:\b.txt".into()]);
        assert_eq!(state.holder_of("main", r"C:\Notes\a.md", &windows), None);
        // A window that is closing, hidden in the background, or gone holds nothing.
        state.start_closing("window-1", &windows);
        assert_eq!(state.holder_of("main", r"C:\b.txt", &windows), None);
        state.cancel_closing("window-1");
        let hidden = views(&[("main", true), ("window-1", false)]);
        assert_eq!(state.holder_of("main", r"C:\b.txt", &hidden), None);
        state.entered_background("window-1");
        assert_eq!(state.holder_of("main", r"C:\b.txt", &windows), None);
        state.set_open_paths("window-2", &[r"C:\b.txt".into()]);
        state.forget("window-2");
        assert_eq!(state.holder_of("main", r"C:\b.txt", &windows), None);
        state.set_open_paths("window-2", &[r"C:\b.txt".into()]);
        state.set_open_paths("window-2", &[]);
        assert_eq!(state.holder_of("main", r"C:\b.txt", &windows), None);
    }

    #[test]
    fn path_keys_match_spellings_of_one_file() {
        let same = [
            r"C:\Notes\a.md",
            "c:/notes/a.md",
            r"\\?\C:\Notes\a.md",
            r"C:\Notes\.\sub\..\a.md",
            r"C:\Notes\a.md.",
            r"C:\Notes\a.md  ",
            r"C:\Notes\\a.md",
        ];
        for path in same {
            assert_eq!(path_key(path), r"c:\notes\a.md", "{path}");
        }
        assert_eq!(
            path_key(r"\\?\UNC\Server\Share\x.txt"),
            r"\\server\share\x.txt"
        );
        assert_eq!(
            path_key(r"\\server\share\..\x.txt"),
            r"\\server\share\x.txt"
        );
        assert_ne!(path_key(r"C:\a.md"), path_key(r"D:\a.md"));
        assert_ne!(path_key(r"C:\a\b.md"), path_key(r"C:\b.md"));
        // Streams are different files from their main data.
        assert_ne!(path_key(r"C:\a.txt:s"), path_key(r"C:\a.txt"));
        // Never empty, even for ".." past the root.
        assert_eq!(path_key(r"C:\..\..\a"), r"c:\a");
    }
}
