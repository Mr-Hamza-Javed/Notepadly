//! Silent updates from GitHub Releases.
//!
//! A plain OS thread, separate from the UI and from the async runtime, checks the
//! release feed a while after launch and then every few hours. A newer version is
//! downloaded and its signature verified in the background. It is installed only
//! when nothing can be lost: when Notepadly goes to the background (every tab is
//! already saved or stored as a draft) or when the app exits. The installer runs
//! in update mode, which never touches app data, and the new version starts back
//! up hidden, so the user just finds the newer version next time they open it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub use crate::update_plan::Phase;
use crate::update_plan::{self, InstallPlan};

/// First check this long after launch, so startup never competes with it.
const FIRST_CHECK: Duration = Duration::from_secs(45);
/// Then again at this interval while the app keeps running (also in the background).
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Written just before installing from the background; tells the new version to
/// start hidden instead of popping up a window nobody asked for.
const RESUME_MARKER: &str = "resume-in-background";
/// A marker older than this is stale (for example the install failed).
const MARKER_MAX_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    /// The version this status is about (the new one), when there is one.
    pub version: Option<String>,
    pub message: Option<String>,
    /// The running version.
    pub current: String,
    /// False for the portable exe, which has no installer to update with.
    pub can_install: bool,
}

pub struct AutoUpdate {
    /// Set from the "Update automatically" setting; nothing is checked until the
    /// frontend has said so.
    enabled: AtomicBool,
    /// The user pressed "Check for updates" since automatic updates were last
    /// turned off, so a download from that check may still be installed.
    asked: AtomicBool,
    checking: AtomicBool,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    status: Mutex<(Phase, Option<String>, Option<String>)>,
    /// This launch was the restart after a background update.
    pub launched_hidden: bool,
}

impl AutoUpdate {
    pub fn new(launched_hidden: bool) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            asked: AtomicBool::new(false),
            checking: AtomicBool::new(false),
            ready: Mutex::new(None),
            status: Mutex::new((Phase::Idle, None, None)),
            launched_hidden,
        }
    }

    fn set(&self, phase: Phase, version: Option<String>, message: Option<String>) {
        *self.status.lock().unwrap() = (phase, version, message);
    }

    /// A downloaded update goes in only while the user still wants it: automatic
    /// updates are on, or they asked for this one with "Check for updates".
    fn may_install(&self) -> bool {
        self.enabled.load(Ordering::Relaxed) || self.asked.load(Ordering::Relaxed)
    }

    fn configure(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            self.asked.store(false, Ordering::Relaxed);
        }
    }
}

fn status_of(app: &AppHandle) -> Status {
    let state = app.state::<AutoUpdate>();
    let (phase, version, message) = state.status.lock().unwrap().clone();
    Status {
        phase,
        version,
        message,
        current: app.package_info().version.to_string(),
        can_install: is_installed(),
    }
}

/// The installer puts `uninstall.exe` next to the app; the portable exe has none.
fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

fn marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(RESUME_MARKER))
}

/// True (once) when this launch, with command-line `args`, is the restart after
/// an update installed from the background. Consumes the marker.
pub fn take_resume_marker(app: &AppHandle, args: &[String]) -> bool {
    marker_path(app).is_some_and(|path| consume_marker(&path, SystemTime::now(), args))
}

/// A second instance that is the installer's restart, arriving after a launch
/// the user made during the install already started this process. Consumes the
/// marker.
pub fn is_late_update_restart(app: &AppHandle, args: &[String]) -> bool {
    take_resume_marker(app, args)
}

/// True when the marker exists, was written at most `MARKER_MAX_AGE` before
/// `now`, and names exactly `args`: the installer restarts the app with the
/// command line of the process that installed the update, so a launch with
/// anything else (a double-clicked file during the install) is the user's and
/// starts normally (RUST-6). Such a launch leaves the marker for the real
/// restart; a match or a stale marker removes it, so it works only once. A
/// marker without arguments (written by an older version) matches any launch.
fn consume_marker(path: &Path, now: SystemTime, args: &[String]) -> bool {
    let fresh = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| now.duration_since(t).ok())
        .is_some_and(|age| age <= MARKER_MAX_AGE);
    if !fresh {
        let _ = std::fs::remove_file(path);
        return false;
    }
    let recorded: Option<Vec<String>> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let matches = recorded.is_none_or(|recorded| recorded == args);
    if matches {
        let _ = std::fs::remove_file(path);
    }
    matches
}

/// Starts the background checker thread.
pub fn start(app: AppHandle) {
    let (settle, rest) = update_plan::first_check_delays(
        std::env::var("NOTEPADLY_UPDATE_FIRST_CHECK_SECS")
            .ok()
            .as_deref(),
        FIRST_CHECK,
    );
    let spawned = std::thread::Builder::new()
        .name("notepadly-updater".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            // Small registry job, shared with this thread so it costs no extra one; it
            // waits a little so it never competes with the window opening.
            std::thread::sleep(settle);
            crate::fileicon::sync();
            std::thread::sleep(rest);
            loop {
                if app.state::<AutoUpdate>().enabled.load(Ordering::Relaxed) {
                    let _ = tauri::async_runtime::block_on(check(&app));
                }
                std::thread::sleep(CHECK_EVERY);
            }
        });
    if let Err(error) = spawned {
        eprintln!("Notepadly: could not start the update checker: {error}");
    }
}

/// Checks the release feed and, when there is a newer version, downloads it.
async fn check(app: &AppHandle) -> Status {
    let state = app.state::<AutoUpdate>();
    let waiting = state.ready.lock().unwrap().is_some();
    // The flag is only taken when no update waits, so a refused check never clears it.
    let checking = !waiting && state.checking.swap(true, Ordering::AcqRel);
    if !update_plan::may_start_check(waiting, checking) {
        return status_of(app);
    }
    state.set(Phase::Checking, None, None);
    let outcome = check_and_download(app).await;
    state.checking.store(false, Ordering::Release);
    match outcome {
        Ok(()) => {}
        Err(message) => state.set(Phase::Error, None, Some(message)),
    }
    // Already waiting in the background: nothing is open, so update right away.
    let ready = state.ready.lock().unwrap().is_some();
    if update_plan::install_after_check(ready, crate::any_window_on_screen(app)) {
        install_if_ready(app, true);
    }
    status_of(app)
}

async fn check_and_download(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AutoUpdate>();
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater
        .check()
        .await
        .map(|update| update.map(|u| (u.version.clone(), u)))
        .map_err(|e| e.to_string());
    let mut ready_version = None;
    let downloaded = update_plan::check_and_download(
        found,
        is_installed(),
        // `download` verifies the signature before returning the bytes.
        |update: &Update| {
            let update = update.clone();
            async move {
                update
                    .download(|_, _| {}, || {})
                    .await
                    .map_err(|e| e.to_string())
            }
        },
        // Ready is shown only once the download is stored below, so the status
        // never says Ready while there is nothing to install.
        &mut |phase, version| match phase {
            Phase::Ready => ready_version = version,
            _ => state.set(phase, version, None),
        },
    )
    .await?;
    if let Some(ready) = downloaded {
        *state.ready.lock().unwrap() = Some(ready);
        state.set(Phase::Ready, ready_version, None);
    }
    Ok(())
}

/// Installs a downloaded update, if there is one. Only call this when every tab is
/// saved or stored as a draft: on success the installer replaces the app and this
/// process exits. `relaunch_hidden` starts the new version back up in the background.
pub fn install_if_ready(app: &AppHandle, relaunch_hidden: bool) {
    let state = app.state::<AutoUpdate>();
    let mut ready = state.ready.lock().unwrap();
    let marker_path = marker_path(app);
    let plan = update_plan::install_plan(
        state.may_install(),
        ready.is_some(),
        relaunch_hidden,
        marker_path.is_some(),
    );
    // Keep: turned off after the download; the bytes stay for when it is turned back on.
    let InstallPlan::Install { marker } = plan else {
        return;
    };
    let Some((update, bytes)) = ready.take() else {
        return;
    };
    drop(ready);
    let marker = marker_path.filter(|_| marker);
    if let Some(path) = &marker {
        // The installer restarts the app with this process's own arguments.
        write_marker(path, &crate::lossy_args(std::env::args_os().skip(1)));
    }
    let update = update.restart_after_install(relaunch_hidden);
    if let Err(error) = update.install(&bytes) {
        eprintln!("Notepadly: update install failed: {error}");
        if let Some(path) = &marker {
            let _ = std::fs::remove_file(path);
        }
        app.state::<AutoUpdate>()
            .set(Phase::Error, None, Some(error.to_string()));
    }
}

/// Records the arguments the installer will restart the app with.
fn write_marker(path: &Path, args: &[String]) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_vec(args).unwrap_or_default();
    let _ = std::fs::write(path, json);
}

/// Turns automatic checks on or off ("Update automatically" in Settings).
#[tauri::command]
pub fn update_configure(app: AppHandle, enabled: bool) -> Status {
    app.state::<AutoUpdate>().configure(enabled);
    status_of(&app)
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> Status {
    status_of(&app)
}

/// "Check for updates" in Settings. Runs off the UI thread like the timed checks.
#[tauri::command]
pub async fn update_check_now(app: AppHandle) -> Status {
    app.state::<AutoUpdate>()
        .asked
        .store(true, Ordering::Relaxed);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || tauri::async_runtime::block_on(check(&handle)))
        .await
        .unwrap_or_else(|_| status_of(&app))
}

/// True when this launch is the hidden restart after a background update; the
/// frontend then stays in the background instead of showing its window. Only the
/// first window starts hidden: a window opened later (a new launch, Ctrl+N) must
/// show.
#[tauri::command]
pub fn launched_hidden(app: AppHandle, window: tauri::WebviewWindow) -> bool {
    app.state::<AutoUpdate>().launched_hidden && window.label() == crate::MAIN_WINDOW
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_marker(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("notepadly-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join(RESUME_MARKER)
    }

    #[test]
    fn a_fresh_marker_means_resume_hidden_exactly_once() {
        let path = temp_marker("fresh");
        write_marker(&path, &[]);
        assert!(consume_marker(&path, SystemTime::now(), &[]));
        assert!(!path.exists());
        assert!(!consume_marker(&path, SystemTime::now(), &[]));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_stale_marker_is_ignored_and_removed() {
        // A marker left by an install that failed must not hide a later normal start.
        let path = temp_marker("stale");
        write_marker(&path, &[]);
        let later = SystemTime::now() + MARKER_MAX_AGE + Duration::from_secs(60);
        assert!(!consume_marker(&path, later, &[]));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_missing_marker_is_a_normal_start() {
        assert!(!consume_marker(
            &temp_marker("missing"),
            SystemTime::now(),
            &[]
        ));
    }

    // BUGS.md RUST-6: a file double-clicked while the installer ran started hidden
    // and was dropped.
    #[test]
    fn a_launch_with_other_arguments_during_the_install_starts_normally() {
        let path = temp_marker("args");
        let old = vec![r"C:\first.txt".to_owned()];
        write_marker(&path, &old);
        let now = SystemTime::now();
        // The user opens another file: a normal start; the marker stays.
        assert!(!consume_marker(&path, now, &[r"C:\other.txt".to_owned()]));
        assert!(!consume_marker(&path, now, &[]));
        assert!(path.exists());
        // The installer's restart, with the old process's arguments: hidden, once.
        assert!(consume_marker(&path, now, &old));
        assert!(!path.exists());
        assert!(!consume_marker(&path, now, &old));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_marker_from_an_older_version_still_resumes_hidden() {
        let path = temp_marker("legacy");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"1").unwrap();
        assert!(consume_marker(
            &path,
            SystemTime::now(),
            &["x.txt".to_owned()]
        ));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn status_serializes_in_the_shape_the_frontend_expects() {
        let status = Status {
            phase: Phase::UpToDate,
            version: Some("1.2.3".into()),
            message: None,
            current: "1.2.2".into(),
            can_install: true,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["phase"], "upToDate");
        assert_eq!(value["canInstall"], true);
        assert_eq!(value["version"], "1.2.3");
        for (phase, name) in [
            (Phase::Idle, "idle"),
            (Phase::Checking, "checking"),
            (Phase::Downloading, "downloading"),
            (Phase::Ready, "ready"),
            (Phase::Available, "available"),
            (Phase::Error, "error"),
        ] {
            assert_eq!(serde_json::to_value(phase).unwrap(), name);
        }
    }

    #[test]
    fn nothing_is_checked_until_the_frontend_enables_it() {
        let state = AutoUpdate::new(false);
        assert!(!state.enabled.load(Ordering::Relaxed));
        assert!(state.ready.lock().unwrap().is_none());
        assert_eq!(state.status.lock().unwrap().0, Phase::Idle);
        assert!(!state.may_install());
    }

    #[test]
    fn turning_updates_off_stops_a_downloaded_update_from_installing() {
        // H13: install_if_ready checks may_install before it takes the download.
        let state = AutoUpdate::new(false);
        state.configure(true);
        assert!(state.may_install());
        state.configure(false);
        assert!(!state.may_install());
        // "Check for updates" pressed with automatic updates off: that download
        // was asked for, so it may go in, until updates are turned off again.
        state.asked.store(true, Ordering::Relaxed);
        assert!(state.may_install());
        state.configure(true);
        state.configure(false);
        assert!(!state.may_install());
    }
}
