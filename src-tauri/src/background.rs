//! Like Windows Notepad, Notepadly stays alive after its last window closes: the
//! window is hidden, its WebView2 is suspended and asked to use little memory,
//! and the next launch shows it again almost at once instead of starting cold.

use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_window_state::AppHandleExt;

use crate::WINDOW_STATE_FLAGS;

/// True when no other window of the app is on screen, so closing this one would
/// otherwise end the app. A window that was just opened and has not shown itself
/// yet counts as on screen (RUST-5); a window that is closing does not. Two
/// windows closing at once should use `window_closing` instead, which decides
/// atomically (STATE-8).
#[tauri::command]
pub fn is_last_window(window: WebviewWindow) -> bool {
    crate::is_last_window(&window)
}

/// Hides the window and puts its webview to sleep instead of closing it.
#[tauri::command]
pub fn enter_background(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    // A hidden window is never "closed", so the plugin would not save its size.
    let _ = app.save_window_state(WINDOW_STATE_FLAGS);
    window.hide().map_err(|e| e.to_string())?;
    app.state::<crate::WindowPaths>()
        .entered_background(window.label());
    // No tab can be torn out with no window on screen: the spare window's memory
    // is better given back. The next drag builds one again.
    for spare in app.state::<crate::window_drag::Spares>().drain() {
        if let Some(spare) = app.get_webview_window(&spare) {
            let _ = spare.destroy();
        }
    }
    set_asleep(&window, true);
    // Every tab is stored now, so this is the safe moment for a downloaded update.
    // The new version comes back up hidden, exactly where this one is going.
    crate::autoupdate::install_if_ready(&app, true);
    Ok(())
}

/// Brings a window forward and, when it was hidden or minimised, makes its
/// WebView2 paint again. A webview that was hidden (a window created with
/// `visible: false`, or one asleep in the background) sometimes does not
/// redraw when its window is shown: only the transparent Mica backdrop shows,
/// like a blur over the window, until the user minimises and restores it
/// (BUGS.md WIN-4). Minimise and restore turn the webview's visibility off and
/// on, so this does the same.
pub fn reveal(window: &WebviewWindow) {
    let was_hidden =
        !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false);
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if was_hidden {
        repaint(window);
    }
}

/// Shows the calling window (instead of the frontend's `show()`) so the
/// WebView2 repaint of `reveal` applies to a window's first show too.
#[tauri::command]
pub fn window_reveal(window: WebviewWindow) {
    reveal(&window);
}

/// How long the webview stays "not visible" before it is made visible again:
/// two frames, so WebView2 sees a real change instead of two calls in a row.
#[cfg(windows)]
const REPAINT_GAP: std::time::Duration = std::time::Duration::from_millis(32);

#[cfg(windows)]
fn repaint(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        // SAFETY: COM call on the webview's own controller, on the main thread
        // where with_webview runs this closure.
        unsafe {
            let _ = webview.controller().SetIsVisible(false);
        }
    });
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(REPAINT_GAP);
        let _ = window.with_webview(|webview| {
            let controller = webview.controller();
            // SAFETY: as above.
            unsafe {
                let _ = controller.SetIsVisible(true);
                let _ = controller.NotifyParentWindowPositionChanged();
            }
        });
    });
}

#[cfg(not(windows))]
fn repaint(_window: &WebviewWindow) {}

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
