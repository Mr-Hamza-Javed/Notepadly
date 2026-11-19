//! Notepadly backend: per-call file I/O, drafts and session, windows, fonts.

mod autoupdate;
mod background;
mod fileicon;
mod files;
mod fonts;
mod oem;
mod store;
mod update_plan;
mod window_state;

use files::{Encoding, FileChunk, FileScan, FileStamp, SaveRequest};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, RunEvent, State, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_window_state::StateFlags;
use window_state::{WindowBoot, WindowPaths, WindowView};

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

/// The file's identity on its volume, the same for every path that reaches it
/// (8.3 short names, a mapped drive and its UNC path, links). None when the
/// file cannot be opened.
#[tauri::command]
async fn path_identity(path: String) -> Result<Option<String>, String> {
    blocking(move || Ok(files::path_identity(Path::new(&path)))).await
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

#[tauri::command]
fn take_pending_paths(window: WebviewWindow, state: State<'_, WindowPaths>) -> Vec<String> {
    state.take(window.label())
}

#[tauri::command]
fn take_window_boot(window: WebviewWindow, state: State<'_, WindowPaths>) -> WindowBoot {
    state.take_boot(window.label())
}

/// Every window's label and whether it is visible, for the rules in `window_state`.
fn window_views(app: &AppHandle) -> Vec<WindowView> {
    app.webview_windows()
        .into_iter()
        .map(|(label, w)| (label, w.is_visible().unwrap_or(false)))
        .collect()
}

/// True when a window is visible, or was just opened and has not shown itself yet.
pub(crate) fn any_window_on_screen(app: &AppHandle) -> bool {
    app.state::<WindowPaths>().any_on_screen(&window_views(app))
}

/// True when no other window is on screen and staying (not closing).
pub(crate) fn is_last_window(window: &WebviewWindow) -> bool {
    let app = window.app_handle();
    app.state::<WindowPaths>()
        .is_last(window.label(), &window_views(app))
}

/// The window starts to close: marks it as closing and returns true when it is
/// the last window on screen, in one step (STATE-8). Of two windows closed at
/// once, exactly one gets true. If the close is then cancelled, call
/// `window_close_cancelled`; going to the background or being destroyed clears
/// the mark by itself.
#[tauri::command]
fn window_closing(window: WebviewWindow, state: State<'_, WindowPaths>) -> bool {
    state.start_closing(window.label(), &window_views(window.app_handle()))
}

/// The close started by `window_closing` was cancelled (for example at "save
/// changes?"), so the window counts as staying again.
#[tauri::command]
fn window_close_cancelled(window: WebviewWindow, state: State<'_, WindowPaths>) {
    state.cancel_closing(window.label());
}

/// Replaces the list of files the calling window has open (WIN-3). Call it
/// whenever a tab opens, closes or is saved under a new name.
#[tauri::command]
fn open_paths_set(window: WebviewWindow, state: State<'_, WindowPaths>, paths: Vec<String>) {
    state.set_open_paths(window.label(), &paths);
}

/// When another window that is on screen has `path` open (WIN-3): brings that
/// window forward, has it switch to the file's tab (an `open-paths-here` event
/// with `[path]`), and returns its label. None when no other window has it.
#[tauri::command]
fn path_open_elsewhere(
    window: WebviewWindow,
    state: State<'_, WindowPaths>,
    path: String,
) -> Option<String> {
    let app = window.app_handle();
    let label = state.holder_of(window.label(), &path, &window_views(app))?;
    let holder = app.get_webview_window(&label)?;
    if state.is_ready(&label) {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            OPEN_PATHS_HERE_EVENT,
            vec![path],
        );
    }
    let _ = holder.unminimize();
    let _ = holder.show();
    let _ = holder.set_focus();
    Some(label)
}

/// The user's regional format as a BCP 47 name (for example "en-GB"), for dates
/// and times (MD-2). The WebView's own locale follows the display language
/// instead. Empty when it cannot be read.
#[tauri::command]
fn user_locale() -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
        const LOCALE_NAME_MAX_LENGTH: usize = 85;
        let mut buffer = [0u16; LOCALE_NAME_MAX_LENGTH];
        // SAFETY: the buffer is as long as the length passed; the call writes a
        // NUL-terminated name and returns its length including the NUL.
        let len = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
        if len > 1 {
            return String::from_utf16_lossy(&buffer[..len as usize - 1]);
        }
    }
    String::new()
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

/// Where and how big a new window opens.
struct Placement {
    /// Logical position, for the window config.
    x: f64,
    y: f64,
    /// Logical inner size; None keeps the config's size (the source is maximized).
    size: Option<(f64, f64)>,
    /// Exact physical position, set once the window exists. The config's logical
    /// position is converted with the scale of whatever monitor Windows creates
    /// the window on, which can differ from the monitor under the cursor.
    physical: Option<(i32, i32)>,
}

/// Position and size for a new window next to `near`, or under the cursor.
/// Must not run on the main thread: `monitor_from_point` waits for it.
fn placement(near: &WebviewWindow, at_cursor: bool) -> Option<Placement> {
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
    if at_cursor {
        let cursor = near.cursor_position().ok()?;
        // The tab may be dropped on another monitor, with another scale.
        let cursor_scale = near
            .monitor_from_point(cursor.x, cursor.y)
            .ok()
            .flatten()
            .map_or(scale, |m| m.scale_factor());
        let (x, y) = cursor_placement((cursor.x, cursor.y), cursor_scale);
        return Some(Placement {
            x,
            y,
            size,
            physical: Some((
                (x * cursor_scale).round() as i32,
                (y * cursor_scale).round() as i32,
            )),
        });
    }
    let pos = near.outer_position().ok()?;
    Some(Placement {
        x: pos.x as f64 / scale + CASCADE,
        y: pos.y as f64 / scale + CASCADE,
        size,
        physical: None,
    })
}

/// Logical top-left of a window for a tab dropped at a physical cursor position
/// on a monitor with `scale`, so the tab lands under the mouse.
fn cursor_placement(cursor: (f64, f64), scale: f64) -> (f64, f64) {
    (
        cursor.0 / scale - DETACHED_TAB_OFFSET.0,
        cursor.1 / scale - DETACHED_TAB_OFFSET.1,
    )
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
    let placed = near.and_then(|w| placement(w, at_cursor));
    if let Some(place) = &placed {
        config.x = Some(place.x);
        config.y = Some(place.y);
        config.center = false;
        if let Some((width, height)) = place.size {
            config.width = width;
            config.height = height;
        }
    }
    state.store(&config.label, paths);
    state.set_boot(&config.label, boot);
    // Hidden until its first paint, but it counts as on screen meanwhile (RUST-5).
    state.mark_booting(&config.label);
    // The config is the main window's, so the WebView2 flags in
    // `additionalBrowserArgs` (tauri.conf.json) apply here too. They turn off
    // msSmartScreenProtection, which is safe only because no Notepadly window
    // ever navigates away from the bundled app: links open in the user's
    // browser through the opener plugin. A window that loads remote pages
    // must not reuse that config.
    let built = WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build());
    match built {
        Ok(window) => {
            if let Some((x, y)) = placed.and_then(|p| p.physical) {
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
            use_sharp_icon(&window);
            Ok(())
        }
        Err(e) => {
            state.forget(&config.label);
            Err(e.to_string())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DropTarget {
    label: String,
    /// Where the cursor is inside that window, in its CSS pixels.
    x: f64,
    y: f64,
}

/// One window a dragged tab could land on, in physical screen pixels.
struct DropCandidate {
    label: String,
    /// Native handle, to match the window Windows reports under the mouse.
    handle: isize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

/// Picks the window a tab dropped at `cursor` lands on. `candidates` lists the
/// visible windows in no particular order, the source window included.
/// `topmost` is the window Windows reports under the mouse: only that one can
/// take the drop, so a window hidden behind another (or behind the source
/// window itself) never does. Without it, the first window under the mouse.
fn pick_drop_target(
    candidates: &[DropCandidate],
    source: &str,
    cursor: (f64, f64),
    topmost: Option<isize>,
) -> Option<DropTarget> {
    candidates
        .iter()
        .filter(|c| topmost.is_none_or(|top| c.handle == top))
        .filter(|c| c.label != source)
        .find_map(|c| {
            let (dx, dy) = (cursor.0 - c.x, cursor.1 - c.y);
            let inside = dx >= 0.0 && dy >= 0.0 && dx < c.width && dy < c.height;
            inside.then(|| DropTarget {
                label: c.label.clone(),
                x: dx / c.scale,
                y: dy / c.scale,
            })
        })
}

/// The top-level window under a point on the screen, as Windows sees it, so
/// the one in front wins where windows overlap.
#[cfg(windows)]
fn topmost_window_at(x: f64, y: f64) -> Option<isize> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    let point = POINT {
        x: x.floor() as i32,
        y: y.floor() as i32,
    };
    // SAFETY: plain Win32 queries; they only read window state.
    unsafe {
        let hit = WindowFromPoint(point);
        if hit.is_null() {
            return None;
        }
        // The hit is usually WebView2's child window; its root is the app window.
        let root = GetAncestor(hit, GA_ROOT);
        (!root.is_null()).then_some(root as isize)
    }
}

#[cfg(not(windows))]
fn topmost_window_at(_x: f64, _y: f64) -> Option<isize> {
    None
}

/// The other visible window under the mouse, for a tab dropped there (F2).
#[tauri::command]
fn tab_drop_target(window: WebviewWindow) -> Option<DropTarget> {
    let cursor = window.cursor_position().ok()?;
    let app = window.app_handle();
    let candidates: Vec<DropCandidate> = app
        .webview_windows()
        .into_values()
        .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .filter_map(|w| {
            let pos = w.inner_position().ok()?;
            let size = w.inner_size().ok()?;
            Some(DropCandidate {
                label: w.label().to_owned(),
                handle: w.hwnd().map_or(0, |h| h.0 as isize),
                x: pos.x as f64,
                y: pos.y as f64,
                width: size.width as f64,
                height: size.height as f64,
                scale: w.scale_factor().ok()?,
            })
        })
        .collect();
    let topmost = topmost_window_at(cursor.x, cursor.y);
    pick_drop_target(&candidates, window.label(), (cursor.x, cursor.y), topmost)
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

/// Command-line arguments as text. `std::env::args` panics on a name that is
/// not valid Unicode (NTFS allows lone surrogates), which aborted the launch.
fn lossy_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<String> {
    args.into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

/// A second launch. Like Notepad (F1), it opens a new window when windows are on
/// screen; files go to the window that last had the focus, which follows "Open
/// files in" and brings itself forward. With no window on screen, the window
/// waiting in the background comes back.
fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let args: Vec<String> = argv.into_iter().skip(1).collect();
    // The installer's restart after a background update, arriving while a launch
    // made during the install is already running (RUST-6): nothing to do.
    if autoupdate::is_late_update_restart(app, &args) {
        return;
    }
    let paths = paths_from_args(args, Path::new(&cwd));
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
            store::process_start();
            // The restart after a background update comes back hidden, and must not
            // reopen whatever file the old process was first started with. Any
            // other launch, such as a double-clicked file while the installer
            // runs, starts normally (RUST-6).
            let args = lossy_args(std::env::args_os().skip(1));
            let hidden = autoupdate::take_resume_marker(app.handle(), &args);
            app.manage(autoupdate::AutoUpdate::new(hidden));
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = if hidden {
                Vec::new()
            } else {
                // The main window shows itself after its first paint.
                app.state::<WindowPaths>().mark_booting(MAIN_WINDOW);
                paths_from_args(args, &cwd)
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
            path_identity,
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
            window_closing,
            window_close_cancelled,
            open_paths_set,
            path_open_elsewhere,
            user_locale,
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

    fn candidate(label: &str, handle: isize, x: f64, width: f64) -> DropCandidate {
        DropCandidate {
            label: label.into(),
            handle,
            x,
            y: 0.0,
            width,
            height: 500.0,
            scale: 2.0,
        }
    }

    #[test]
    fn a_tab_drops_on_the_window_in_front_not_one_behind_it() {
        // window-1 lies behind window-2 where they overlap (x 300..500).
        let windows = [
            candidate("main", 1, 0.0, 200.0),
            candidate("window-1", 2, 0.0, 500.0),
            candidate("window-2", 3, 300.0, 500.0),
        ];
        let label = |t: Option<DropTarget>| t.map(|t| t.label);
        // Over the overlap, Windows reports window-2 in front.
        assert_eq!(
            label(pick_drop_target(&windows, "main", (400.0, 10.0), Some(3))).as_deref(),
            Some("window-2")
        );
        // Dropped over the source window itself, which covers window-1 there:
        // no other window takes it (it opens a new window instead).
        assert!(pick_drop_target(&windows, "main", (100.0, 10.0), Some(1)).is_none());
        // A window of another app is in front: no drop target.
        assert!(pick_drop_target(&windows, "main", (400.0, 10.0), Some(99)).is_none());
        // Without z-order information, any window under the mouse.
        let free = pick_drop_target(&windows, "main", (100.0, 10.0), None).unwrap();
        assert_eq!(
            (free.label.as_str(), free.x, free.y),
            ("window-1", 50.0, 5.0)
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_file_name_that_is_not_unicode_does_not_stop_the_launch() {
        use std::os::windows::ffi::OsStringExt;
        // "a" followed by a lone high surrogate, legal in an NTFS name.
        let odd = std::ffi::OsString::from_wide(&[0x61, 0xD800]);
        assert_eq!(lossy_args([odd, "b.txt".into()]), ["a\u{FFFD}", "b.txt"]);
    }

    #[test]
    fn a_dragged_tab_window_uses_the_scale_of_the_monitor_under_the_cursor() {
        // Cursor at physical (3000, 400) on a 150% monitor: logical (2000, 266.67).
        let (x, y) = cursor_placement((3000.0, 400.0), 1.5);
        assert_eq!(x, 2000.0 - DETACHED_TAB_OFFSET.0);
        assert!((y - (400.0 / 1.5 - DETACHED_TAB_OFFSET.1)).abs() < 1e-9);
        // The same point on a 100% monitor.
        assert_eq!(
            cursor_placement((3000.0, 400.0), 1.0),
            (
                3000.0 - DETACHED_TAB_OFFSET.0,
                400.0 - DETACHED_TAB_OFFSET.1
            )
        );
    }
}
