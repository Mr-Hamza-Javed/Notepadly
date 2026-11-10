//! Like Windows Notepad, Notepadly stays alive after its last window closes: the
//! window is hidden, its WebView2 is suspended and asked to use little memory,
//! and the next launch shows it again almost at once instead of starting cold.

use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_window_state::AppHandleExt;

use crate::WINDOW_STATE_FLAGS;

/// True when no other window of the app is on screen, so closing this one would
/// otherwise end the app.
#[tauri::command]
pub fn is_last_window(window: WebviewWindow) -> bool {
    window
        .app_handle()
        .webview_windows()
        .values()
        .all(|w| w.label() == window.label() || !w.is_visible().unwrap_or(false))
}

/// Hides the window and puts its webview to sleep instead of closing it.
#[tauri::command]
pub fn enter_background(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    // A hidden window is never "closed", so the plugin would not save its size.
    let _ = app.save_window_state(WINDOW_STATE_FLAGS);
    window.hide().map_err(|e| e.to_string())?;
    set_asleep(&window, true);
    Ok(())
}

/// True when the window was waiting in the background.
pub fn is_in_background(window: &WebviewWindow) -> bool {
    !window.is_visible().unwrap_or(true)
}

/// Wakes a window that `enter_background` put to sleep. Call before showing it.
pub fn wake(window: &WebviewWindow) {
    set_asleep(window, false);
}

#[cfg(windows)]
fn set_asleep(window: &WebviewWindow, asleep: bool) {
    let _ = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;

        let controller = webview.controller();
        // SAFETY: COM calls on the webview's own controller, made on the main
        // thread where with_webview runs this closure.
        unsafe {
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let level = if asleep {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            if asleep {
                // TrySuspend only works on a webview that is not visible.
                let _ = controller.SetIsVisible(false);
                if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                    let _ = core19.SetMemoryUsageTargetLevel(level);
                }
                if let Ok(core3) = core.cast::<ICoreWebView2_3>() {
                    let done = webview2_com::TrySuspendCompletedHandler::create(Box::new(
                        |_result, _suspended| {
                            trim_own_memory();
                            Ok(())
                        },
                    ));
                    let _ = core3.TrySuspend(&done);
                }
                trim_own_memory();
            } else {
                if let Ok(core3) = core.cast::<ICoreWebView2_3>() {
                    let _ = core3.Resume();
                }
                if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                    let _ = core19.SetMemoryUsageTargetLevel(level);
                }
                let _ = controller.SetIsVisible(true);
            }
        }
    });
}

#[cfg(not(windows))]
fn set_asleep(_window: &WebviewWindow, _asleep: bool) {}

/// Hands this process's unused pages back to Windows while it waits.
#[cfg(windows)]
fn trim_own_memory() {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetProcessWorkingSetSize};
    // SAFETY: (usize::MAX, usize::MAX) is the documented "trim now" request for
    // the current process; it touches no memory we own.
    unsafe {
        SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}
