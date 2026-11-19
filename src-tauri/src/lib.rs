//! Notepadly backend: per-call file I/O, drafts and session, windows, fonts.

mod autoupdate;
mod background;
mod fileicon;
mod files;
mod fonts;
mod store;

use files::{Encoding, FileChunk, FileScan, FileStamp, SaveRequest};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, RunEvent, State, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_window_state::StateFlags;

const MAIN_WINDOW: &str = "main";
const OPEN_PATHS_EVENT: &str = "open-paths";
/// Paths for a window that was waiting in the background: it opens them in a tab
/// whatever "Open files in" says, since it is the only window.
const OPEN_PATHS_HERE_EVENT: &str = "open-paths-here";
/// How far a new window is moved from the window it was opened from, in logical px.
const CASCADE: f64 = 32.0;
/// Where a dragged-out tab sits in its new window, from the window's top-left corner.
const DETACHED_TAB_OFFSET: (f64, f64) = (120.0, 18.0);
/// What the window-state plugin remembers. VISIBLE must stay out: the frontend
/// shows the window after first paint.
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// Runs blocking work on the blocking pool, never on the main thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
async fn file_read_chunk(
    path: String,
    offset: u64,
    max_bytes: u64,
    encoding: Option<Encoding>,
) -> Result<FileChunk, String> {
    blocking(move || files::read_chunk(Path::new(&path), offset, max_bytes, encoding)).await
}

#[tauri::command]
async fn file_stat(path: String) -> Result<Option<FileStamp>, String> {
    blocking(move || files::stat(Path::new(&path))).await
}

#[tauri::command]
async fn file_save(req: SaveRequest) -> Result<FileStamp, String> {
    blocking(move || files::save(&req)).await
}

#[tauri::command]
async fn file_scan(path: String, encoding: Encoding) -> Result<FileScan, String> {
    blocking(move || files::scan(Path::new(&path), encoding)).await
}

#[tauri::command]
async fn session_read(app: AppHandle) -> Result<Option<String>, String> {
    let base = data_dir(&app)?;
    blocking(move || store::session_read(&base)).await
}

#[tauri::command]
async fn session_write(app: AppHandle, json: String) -> Result<(), String> {
    let base = data_dir(&app)?;
    blocking(move || store::session_write(&base, &json)).await
}

#[tauri::command]
async fn draft_read(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let base = data_dir(&app)?;
    blocking(move || store::draft_read(&base, &id)).await
}

#[tauri::command]
async fn draft_write(app: AppHandle, id: String, text: String) -> Result<(), String> {
    let base = data_dir(&app)?;
    blocking(move || store::draft_write(&base, &id, &text)).await
}

#[tauri::command]
async fn draft_delete(app: AppHandle, id: String) -> Result<(), String> {
    let base = data_dir(&app)?;
    blocking(move || store::draft_delete(&base, &id)).await
}

#[derive(Serialize)]
struct WindowSession {
    key: String,
    json: String,
}

/// Every window's stored session (sessions/<key>.json).
#[tauri::command]
async fn window_sessions_read(app: AppHandle) -> Result<Vec<WindowSession>, String> {
    let base = data_dir(&app)?;
    let list = blocking(move || store::window_sessions_read(&base)).await?;
    Ok(list
        .into_iter()
        .map(|(key, json)| WindowSession { key, json })
        .collect())
}

#[tauri::command]
async fn window_session_write(app: AppHandle, key: String, json: String) -> Result<(), String> {
    let base = data_dir(&app)?;
    blocking(move || store::window_session_write(&base, &key, &json)).await
}

#[tauri::command]
async fn window_session_delete(app: AppHandle, key: String) -> Result<(), String> {
    let base = data_dir(&app)?;
    blocking(move || store::window_session_delete(&base, &key)).await
}

#[tauri::command]
async fn drafts_prune(app: AppHandle, keep: Vec<String>) -> Result<(), String> {
    let base = data_dir(&app)?;
    blocking(move || store::drafts_prune(&base, &keep)).await
}

#[tauri::command]
async fn system_fonts() -> Result<Vec<String>, String> {
    blocking(|| Ok(fonts::system_fonts())).await
}

#[tauri::command]
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    blocking(move || tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())).await
}

/// Paths waiting for each window, plus which windows have started listening.
#[derive(Default)]
struct WindowPaths {
    next_id: AtomicU64,
    inner: Mutex<PathsInner>,
}

#[derive(Default)]
struct PathsInner {
    pending: HashMap<String, Vec<String>>,
    ready: HashSet<String>,
    /// What a new window starts with besides paths: a stored session to restore or
    /// a tab dragged in from another window.
    boot: HashMap<String, WindowBoot>,
    /// The window that last had the focus: a second launch with files goes there.
    focused: Option<String>,
}

#[derive(Default, Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBoot {
    /// Key of the stored window session this window takes over.
    restore: Option<String>,
    /// JSON of a tab moved here from another window (the frontend's TabTransfer).
    transfer: Option<String>,
}

impl WindowPaths {
    fn lock(&self) -> std::sync::MutexGuard<'_, PathsInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn store(&self, label: &str, paths: Vec<String>) {
        if !paths.is_empty() {
            self.lock()
                .pending
                .entry(label.to_owned())
                .or_default()
                .extend(paths);
        }
    }

    fn take(&self, label: &str) -> Vec<String> {
        let mut inner = self.lock();
        inner.ready.insert(label.to_owned());
        inner.pending.remove(label).unwrap_or_default()
    }

    fn is_ready(&self, label: &str) -> bool {
        self.lock().ready.contains(label)
    }

    fn forget(&self, label: &str) {
        let mut inner = self.lock();
        inner.pending.remove(label);
        inner.ready.remove(label);
        inner.boot.remove(label);
        if inner.focused.as_deref() == Some(label) {
            inner.focused = None;
        }
    }

    fn set_boot(&self, label: &str, boot: WindowBoot) {
        if boot != WindowBoot::default() {
            self.lock().boot.insert(label.to_owned(), boot);
        }
    }

    fn take_boot(&self, label: &str) -> WindowBoot {
        self.lock().boot.remove(label).unwrap_or_default()
    }

    fn set_focused(&self, label: &str) {
        self.lock().focused = Some(label.to_owned());
    }

    fn focused(&self) -> Option<String> {
        self.lock().focused.clone()
    }

    /// A label no window has: window-1, window-2, ...
    fn new_label(&self, taken: impl Fn(&str) -> bool) -> String {
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
}

#[tauri::command]
fn take_pending_paths(window: WebviewWindow, state: State<'_, WindowPaths>) -> Vec<String> {
    state.take(window.label())
}

#[tauri::command]
fn take_window_boot(window: WebviewWindow, state: State<'_, WindowPaths>) -> WindowBoot {
    state.take_boot(window.label())
}

/// Async because building a window from a synchronous command deadlocks on
/// Windows (WebView2 needs the main thread that command would be blocking).
/// `restore` names a stored window session for it to take over, `transfer` is a
/// tab dragged out of `window`, and `at_cursor` puts the new window under the
/// mouse (for that drag); otherwise it opens a little below and right of `window`.
#[tauri::command]
async fn window_new(
    app: AppHandle,
    window: WebviewWindow,
    paths: Vec<String>,
    restore: Option<String>,
    transfer: Option<String>,
    at_cursor: Option<bool>,
) -> Result<(), String> {
    let boot = WindowBoot { restore, transfer };
    open_window(&app, paths, boot, Some(&window), at_cursor.unwrap_or(false))
}

/// Logical position and size for a new window next to `near`, or under the cursor.
fn placement(near: &WebviewWindow, at_cursor: bool) -> Option<(f64, f64, Option<(f64, f64)>)> {
    if !near.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = near.scale_factor().ok()?;
    let size = if near.is_maximized().unwrap_or(false) {
        None
    } else {
        let inner = near.inner_size().ok()?;
        Some((inner.width as f64 / scale, inner.height as f64 / scale))
    };
    let (x, y) = if at_cursor {
        let cursor = near.cursor_position().ok()?;
        (
            cursor.x / scale - DETACHED_TAB_OFFSET.0,
            cursor.y / scale - DETACHED_TAB_OFFSET.1,
        )
    } else {
        let pos = near.outer_position().ok()?;
        (
            pos.x as f64 / scale + CASCADE,
            pos.y as f64 / scale + CASCADE,
        )
    };
    Some((x, y, size))
}

/// Builds a window from the main window's config. Extra windows used to open at
/// the config's 1280x800 every time (M18); they now take the size of the window
/// they were opened from.
fn open_window(
    app: &AppHandle,
    paths: Vec<String>,
    boot: WindowBoot,
    near: Option<&WebviewWindow>,
    at_cursor: bool,
) -> Result<(), String> {
    let state = app.state::<WindowPaths>();
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .ok_or("main window config is missing")?;
    config.label = state.new_label(|label| app.get_webview_window(label).is_some());
    if let Some((x, y, size)) = near.and_then(|w| placement(w, at_cursor)) {
        config.x = Some(x);
        config.y = Some(y);
        config.center = false;
        if let Some((width, height)) = size {
            config.width = width;
            config.height = height;
        }
    }
    state.store(&config.label, paths);
    state.set_boot(&config.label, boot);
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build());
    built.map(|w| use_sharp_icon(&w)).map_err(|e| {
        state.forget(&config.label);
        e.to_string()
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DropTarget {
    label: String,
    /// Where the cursor is inside that window, in its CSS pixels.
    x: f64,
    y: f64,
}

/// The other visible window under the mouse, for a tab dropped there (F2).
#[tauri::command]
fn tab_drop_target(window: WebviewWindow) -> Option<DropTarget> {
    let cursor = window.cursor_position().ok()?;
    let app = window.app_handle();
    app.webview_windows()
        .into_values()
        .filter(|w| w.label() != window.label() && w.is_visible().unwrap_or(false))
        .filter(|w| !w.is_minimized().unwrap_or(false))
        .find_map(|w| {
            let pos = w.inner_position().ok()?;
            let size = w.inner_size().ok()?;
            let scale = w.scale_factor().ok()?;
            let (dx, dy) = (cursor.x - pos.x as f64, cursor.y - pos.y as f64);
            let inside =
                dx >= 0.0 && dy >= 0.0 && dx < size.width as f64 && dy < size.height as f64;
            inside.then(|| DropTarget {
                label: w.label().to_owned(),
                x: dx / scale,
                y: dy / scale,
            })
        })
}

/// Tauri gives a window one 256 px icon and Windows shrinks it for the taskbar and
/// Alt+Tab, which blurs it. Load the exact sizes this window's DPI needs from the
/// exe's own multi-size icon resource instead.
#[cfg(windows)]
fn use_sharp_icon(window: &WebviewWindow) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON,
        SM_CXSMICON, WM_SETICON,
    };
    /// Where tauri-build puts the bundle icon (tauri_utils::platform::WINDOWS_APP_ICON_RESOURCE_ID).
    const APP_ICON_ID: usize = 32512;

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    // SAFETY: plain Win32 calls on a live window handle owned by this process; the
    // resource id is passed MAKEINTRESOURCE-style as the name pointer.
    unsafe {
        let dpi = GetDpiForWindow(hwnd);
        let module = GetModuleHandleW(std::ptr::null());
        // The taskbar draws ICON_SMALL at SM_CXSMICON, so it must be that exact size
        // to stay sharp.
        for (kind, metric) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
            let size = GetSystemMetricsForDpi(metric, dpi);
            let icon = LoadImageW(
                module,
                APP_ICON_ID as *const u16,
                IMAGE_ICON,
                size,
                size,
                LR_DEFAULTCOLOR,
            );
            if !icon.is_null() {
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}

#[cfg(not(windows))]
fn use_sharp_icon(_window: &WebviewWindow) {}

/// Files named on a command line, made absolute against `cwd`. A name that does
/// not exist yet is kept when its folder exists (M11): the frontend offers to
/// create it, like Notepad. Arguments starting with `-` are flags, unless a file
/// by that name exists.
fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|arg| !arg.is_empty())
        .map(|arg| (arg.starts_with('-'), cwd.join(arg)))
        .filter(|(flag, path)| {
            if path.is_file() {
                return true;
            }
            let new_file = !path.exists()
                && path
                    .parent()
                    .is_some_and(|dir| dir.as_os_str().is_empty() || dir.is_dir());
            !flag && new_file
        })
        .map(|(_, path)| path.to_string_lossy().into_owned())
        .collect()
}

/// A second launch. Like Notepad (F1), it opens a new window when windows are on
/// screen; files go to the window that last had the focus, which follows "Open
/// files in" and brings itself forward. With no window on screen, the window
/// waiting in the background comes back.
fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let paths = paths_from_args(argv.into_iter().skip(1), Path::new(&cwd));
    let state = app.state::<WindowPaths>();
    let windows = app.webview_windows();
    let on_screen = |w: &&WebviewWindow| w.is_visible().unwrap_or(false);
    let focused = state
        .focused()
        .and_then(|label| windows.get(&label))
        .filter(on_screen)
        .or_else(|| windows.get(MAIN_WINDOW).filter(on_screen))
        .or_else(|| windows.values().find(on_screen));
    if let Some(window) = focused {
        let label = window.label().to_owned();
        if paths.is_empty() {
            let app = app.clone();
            let near = window.clone();
            // Off the main thread, as window_new is (see there).
            tauri::async_runtime::spawn(async move {
                if let Err(error) =
                    open_window(&app, Vec::new(), WindowBoot::default(), Some(&near), false)
                {
                    eprintln!("Notepadly: could not open a new window: {error}");
                }
            });
        } else if state.is_ready(&label) {
            let _ = app.emit_to(EventTarget::webview_window(label), OPEN_PATHS_EVENT, paths);
        } else {
            state.store(&label, paths);
        }
        return;
    }
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .or_else(|| windows.into_values().next());
    let Some(window) = window else { return };
    let label = window.label().to_owned();
    // Waiting in the background after its last window closed: wake it first so
    // the page can take the paths, then show it below.
    if background::is_in_background(&window) && state.is_ready(&label) {
        background::wake(&window);
    }
    if !state.is_ready(&label) {
        // Frontend still booting: it drains these and shows the window itself.
        state.store(&label, paths);
        return;
    }
    if !paths.is_empty() {
        let _ = app.emit_to(
            EventTarget::webview_window(label),
            OPEN_PATHS_HERE_EVENT,
            paths,
        );
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn run() {
    // A second launch only forwards its arguments to the running instance. Windows
    // gives the right to come to the front to the process the user just started,
    // so hand it on; otherwise a window woken from the background opens behind.
    #[cfg(windows)]
    // SAFETY: plain Win32 call with a constant argument.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(
            windows_sys::Win32::UI::WindowsAndMessaging::ASFW_ANY,
        );
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            on_second_instance(app, argv, cwd)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .with_filter(|label| label == MAIN_WINDOW)
                .build(),
        )
        .manage(WindowPaths::default())
        .setup(|app| {
            // The restart after a background update comes back hidden, and must not
            // reopen whatever file the old process was first started with.
            let hidden = autoupdate::take_resume_marker(app.handle());
            app.manage(autoupdate::AutoUpdate::new(hidden));
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = if hidden {
                Vec::new()
            } else {
                paths_from_args(std::env::args().skip(1), &cwd)
            };
            app.state::<WindowPaths>().store(MAIN_WINDOW, paths);
            autoupdate::start(app.handle().clone());
            if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
                use_sharp_icon(&main);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => window.state::<WindowPaths>().forget(window.label()),
            WindowEvent::Focused(true) => window.state::<WindowPaths>().set_focused(window.label()),
            // Moving to a monitor with another scale needs icons of another size.
            WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    use_sharp_icon(&w);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            file_read_chunk,
            file_stat,
            file_save,
            file_scan,
            session_read,
            session_write,
            draft_read,
            draft_write,
            draft_delete,
            drafts_prune,
            take_pending_paths,
            take_window_boot,
            window_new,
            window_sessions_read,
            window_session_write,
            window_session_delete,
            tab_drop_target,
            system_fonts,
            reveal_in_explorer,
            background::is_last_window,
            background::enter_background,
            autoupdate::update_configure,
            autoupdate::update_status,
            autoupdate::update_check_now,
            autoupdate::launched_hidden,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Notepadly")
        .run(|app, event| {
            // With background mode off the app really quits; every window has
            // already stored or resolved its tabs, so a waiting update can go in now.
            if let RunEvent::Exit = event {
                autoupdate::install_if_ready(app, false);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_keep_only_existing_files_made_absolute() {
        let dir = std::env::temp_dir();
        let name = format!("notepadly-args-{}.md", std::process::id());
        std::fs::write(dir.join(&name), "x").unwrap();
        let args = vec![
            name.clone(),
            "--flag".into(),
            "missing-folder/missing-file.md".into(),
        ];
        assert_eq!(
            paths_from_args(args, &dir),
            vec![dir.join(&name).to_string_lossy().into_owned()]
        );
        std::fs::remove_file(dir.join(&name)).unwrap();
    }

    #[test]
    fn args_accept_absolute_paths_spaces_and_unicode_but_not_folders() {
        let dir = std::env::temp_dir().join(format!("notepadly-args-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub folder")).unwrap();
        let spaced = dir.join("my notes اردو 😀.md");
        std::fs::write(&spaced, "x").unwrap();
        // A folder that does not exist, so the relative name is not a new file there.
        let elsewhere = std::env::temp_dir().join("notepadly-no-such-folder");
        let args = vec![
            spaced.to_string_lossy().into_owned(),
            "sub folder".into(),
            "my notes اردو 😀.md".into(),
        ];
        let expected = spaced.to_string_lossy().into_owned();
        // An absolute argument ignores the working directory; a relative one uses it.
        assert_eq!(
            paths_from_args(args.clone(), &elsewhere),
            vec![expected.clone()]
        );
        assert_eq!(
            paths_from_args(args, &dir),
            vec![expected.clone(), expected]
        );
        std::fs::remove_dir_all(&dir).unwrap();
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
    fn args_keep_a_new_file_name_but_not_flags() {
        let dir = std::env::temp_dir().join(format!("notepadly-args-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("-dash.md"), "x").unwrap();
        let args = vec![
            "new note.txt".into(),
            "--flag".into(),
            "-dash.md".into(),
            "no-such-folder/x.md".into(),
            String::new(),
        ];
        assert_eq!(
            paths_from_args(args, &dir),
            vec![
                dir.join("new note.txt").to_string_lossy().into_owned(),
                dir.join("-dash.md").to_string_lossy().into_owned(),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
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
}
