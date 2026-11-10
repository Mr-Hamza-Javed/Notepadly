//! Notepadly backend: per-call file I/O, drafts and session, windows, fonts.

mod files;
mod fonts;
mod store;

use files::{Encoding, FileChunk, FileScan, FileStamp, SaveRequest};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_window_state::StateFlags;

const MAIN_WINDOW: &str = "main";
const OPEN_PATHS_EVENT: &str = "open-paths";

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
    }
}

#[tauri::command]
fn take_pending_paths(window: WebviewWindow, state: State<'_, WindowPaths>) -> Vec<String> {
    state.take(window.label())
}

/// Async because building a window from a synchronous command deadlocks on
/// Windows (WebView2 needs the main thread that command would be blocking).
#[tauri::command]
async fn window_new(
    app: AppHandle,
    state: State<'_, WindowPaths>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .ok_or("main window config is missing")?;
    config.label = format!(
        "window-{}",
        state.next_id.fetch_add(1, Ordering::Relaxed) + 1
    );
    state.store(&config.label, paths);
    let built = WebviewWindowBuilder::from_config(&app, &config).and_then(|b| b.build());
    built.map(|w| use_sharp_icon(&w)).map_err(|e| {
        state.forget(&config.label);
        e.to_string()
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

/// Existing files named on a command line, made absolute against `cwd`.
fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn on_second_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    let paths = paths_from_args(argv.into_iter().skip(1), Path::new(&cwd));
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .or_else(|| app.webview_windows().into_values().next());
    let Some(window) = window else { return };
    let state = app.state::<WindowPaths>();
    let label = window.label().to_owned();
    if !state.is_ready(&label) {
        // Frontend still booting: it drains these and shows the window itself.
        state.store(&label, paths);
        return;
    }
    if !paths.is_empty() {
        let _ = app.emit_to(EventTarget::webview_window(label), OPEN_PATHS_EVENT, paths);
    }
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            on_second_instance(app, argv, cwd)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // VISIBLE must stay out: the frontend shows the window after first paint.
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .with_filter(|label| label == MAIN_WINDOW)
                .build(),
        )
        .manage(WindowPaths::default())
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            let paths = paths_from_args(std::env::args().skip(1), &cwd);
            app.state::<WindowPaths>().store(MAIN_WINDOW, paths);
            if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
                use_sharp_icon(&main);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => window.state::<WindowPaths>().forget(window.label()),
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
            take_pending_paths,
            window_new,
            system_fonts,
            reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Notepadly");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_keep_only_existing_files_made_absolute() {
        let dir = std::env::temp_dir();
        let name = format!("notepadly-args-{}.md", std::process::id());
        std::fs::write(dir.join(&name), "x").unwrap();
        let args = vec![name.clone(), "--flag".into(), "missing-file.md".into()];
        assert_eq!(
            paths_from_args(args, &dir),
            vec![dir.join(&name).to_string_lossy().into_owned()]
        );
        std::fs::remove_file(dir.join(&name)).unwrap();
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
