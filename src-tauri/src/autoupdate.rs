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

/// First check this long after launch, so startup never competes with it.
const FIRST_CHECK: Duration = Duration::from_secs(45);
/// Then again at this interval while the app keeps running (also in the background).
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Written just before installing from the background; tells the new version to
/// start hidden instead of popping up a window nobody asked for.
const RESUME_MARKER: &str = "resume-in-background";
/// A marker older than this is stale (for example the install failed).
const MARKER_MAX_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    UpToDate,
    Downloading,
    /// Downloaded and verified; installs when Notepadly closes.
    Ready,
    /// A newer version exists but this copy cannot update itself (portable exe).
    Available,
    Error,
}

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
            checking: AtomicBool::new(false),
            ready: Mutex::new(None),
            status: Mutex::new((Phase::Idle, None, None)),
            launched_hidden,
        }
    }

    fn set(&self, phase: Phase, version: Option<String>, message: Option<String>) {
        *self.status.lock().unwrap() = (phase, version, message);
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

/// True (once) when this launch is the restart after an update installed from the
/// background. Consumes the marker.
pub fn take_resume_marker(app: &AppHandle) -> bool {
    let Some(path) = marker_path(app) else {
        return false;
    };
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age <= MARKER_MAX_AGE);
    let _ = std::fs::remove_file(&path);
    fresh
}

/// Starts the background checker thread.
pub fn start(app: AppHandle) {
    let first = std::env::var("NOTEPADLY_UPDATE_FIRST_CHECK_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(FIRST_CHECK);
    let spawned = std::thread::Builder::new()
        .name("notepadly-updater".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            // Small registry job, shared with this thread so it costs no extra one; it
            // waits a little so it never competes with the window opening.
            let settle = Duration::from_secs(5).min(first);
            std::thread::sleep(settle);
            crate::fileicon::sync();
            std::thread::sleep(first - settle);
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
    if state.ready.lock().unwrap().is_some() || state.checking.swap(true, Ordering::AcqRel) {
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
    if ready && no_window_on_screen(app) {
        install_if_ready(app, true);
    }
    status_of(app)
}

async fn check_and_download(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AutoUpdate>();
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        state.set(Phase::UpToDate, None, None);
        return Ok(());
    };
    let version = update.version.clone();
    if !is_installed() {
        state.set(Phase::Available, Some(version), None);
        return Ok(());
    }
    state.set(Phase::Downloading, Some(version.clone()), None);
    // `download` verifies the signature before returning the bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    *state.ready.lock().unwrap() = Some((update, bytes));
    state.set(Phase::Ready, Some(version), None);
    Ok(())
}

fn no_window_on_screen(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .all(|w| !w.is_visible().unwrap_or(false))
}

/// Installs a downloaded update, if there is one. Only call this when every tab is
/// saved or stored as a draft: on success the installer replaces the app and this
/// process exits. `relaunch_hidden` starts the new version back up in the background.
pub fn install_if_ready(app: &AppHandle, relaunch_hidden: bool) {
    let Some((update, bytes)) = app.state::<AutoUpdate>().ready.lock().unwrap().take() else {
        return;
    };
    let marker = marker_path(app).filter(|_| relaunch_hidden);
    if let Some(path) = &marker {
        write_marker(path);
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

fn write_marker(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, b"1");
}

/// Turns automatic checks on or off ("Update automatically" in Settings).
#[tauri::command]
pub fn update_configure(app: AppHandle, enabled: bool) -> Status {
    app.state::<AutoUpdate>()
        .enabled
        .store(enabled, Ordering::Relaxed);
    status_of(&app)
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> Status {
    status_of(&app)
}

/// "Check for updates" in Settings. Runs off the UI thread like the timed checks.
#[tauri::command]
pub async fn update_check_now(app: AppHandle) -> Status {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || tauri::async_runtime::block_on(check(&handle)))
        .await
        .unwrap_or_else(|_| status_of(&app))
}

/// True when this launch is the hidden restart after a background update; the
/// frontend then stays in the background instead of showing its window.
#[tauri::command]
pub fn launched_hidden(app: AppHandle) -> bool {
    app.state::<AutoUpdate>().launched_hidden
}
