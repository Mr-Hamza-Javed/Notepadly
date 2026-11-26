// Dragging a tab out like in Chrome (F2): the window that holds the dragged tab
// (a new one, or the source itself when that tab was its only one) follows the
// mouse until the button goes up. The window under the mouse hears where the tab
// is over its tab strip, so it can open a gap there, and the dragged window is
// told at the end where it was dropped.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// Sent to the window under the mouse while a tab is over its tab strip.
pub const HOVER_EVENT: &str = "tab-drag-hover";
/// Sent to that window when the tab leaves its tab strip or the drag ends.
pub const LEAVE_EVENT: &str = "tab-drag-leave";
/// Sent to the dragged window when the drag is over; it then calls `window_drag_result`.
pub const END_EVENT: &str = "window-drag-end";

/// Height of the tab strip in CSS pixels (`--strip-h` in tokens.css).
pub const STRIP_HEIGHT: f64 = 41.0;
/// How far below the tab strip a tab still counts as over it, in CSS pixels.
pub const ATTACH_SLACK: f64 = 16.0;

/// Where a dragged tab is over another window's tab strip, in that window's CSS pixels.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StripPoint {
    pub label: String,
    pub x: f64,
    pub y: f64,
}

/// How a window drag ended.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragEnd {
    /// The tab strip the tab was dropped on, if any.
    pub target: Option<StripPoint>,
    /// Escape was pressed: the tab goes back where it came from.
    pub cancelled: bool,
}

/// The windows being dragged, and how the finished drags ended until each
/// dragged window has taken its answer.
#[derive(Default)]
pub struct WindowDrags {
    active: Mutex<HashSet<String>>,
    ended: Mutex<HashMap<String, DragEnd>>,
}

impl WindowDrags {
    /// Starts a drag of `label`. False when one is already running for it.
    pub fn begin(&self, label: &str) -> bool {
        self.ended
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.to_owned())
    }

    /// Records how the drag of `label` ended.
    pub fn finish(&self, label: &str, end: DragEnd) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        self.ended
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.to_owned(), end);
    }

    /// How the drag of `label` ended, given once. None while it runs, or when
    /// there was none or it was already taken.
    pub fn take(&self, label: &str) -> Option<DragEnd> {
        self.ended
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label)
    }

    #[cfg(test)]
    pub fn is_dragging(&self, label: &str) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(label)
    }

    /// The window is gone: nothing more to answer.
    pub fn forget(&self, label: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        self.ended
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
    }
}

/// The cursor, in CSS pixels of the window under it, is over that window's tab
/// strip (or just below it): the dragged tab snaps into those tabs there.
pub fn over_strip(x: f64, y: f64, width: f64) -> bool {
    (0.0..width).contains(&x) && (0.0..STRIP_HEIGHT + ATTACH_SLACK).contains(&y)
}

/// How far a tab snapped into a strip may wander before it tears off again, in
/// CSS pixels: a little wider than where it snaps in, so it does not flicker
/// between the two at the edge.
pub const KEEP_MARGIN: f64 = 28.0;

/// A tab snapped into a strip stays there while the cursor (CSS pixels of that
/// window, which may be outside it) is this close to the strip.
pub fn keeps_attached(x: f64, y: f64, width: f64) -> bool {
    (-KEEP_MARGIN..width + KEEP_MARGIN).contains(&x)
        && (-KEEP_MARGIN..STRIP_HEIGHT + ATTACH_SLACK + KEEP_MARGIN).contains(&y)
}

/// The tab being dragged, for the strip it snaps into to show it under the mouse.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragTab {
    pub title: String,
    pub dirty: bool,
    /// Where the mouse holds the tab, in CSS pixels from the dragged window's left
    /// edge (the strip works out the point inside the tab from its own layout).
    pub grab_x: f64,
}

/// Sent with HOVER_EVENT: where the snapped-in tab is, and what it shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragHover {
    pub x: f64,
    pub y: f64,
    pub title: String,
    pub dirty: bool,
    pub grab_x: f64,
}

/// A hidden window booted ahead of time, so a torn-out tab has a window at once
/// instead of waiting for a new WebView to start (F2, as smooth as Chrome). It
/// is not a window of the app until it is claimed: no session, not counted as
/// on screen, never sent files.
#[derive(Default)]
pub struct Spares {
    inner: Mutex<SpareInner>,
}

#[derive(Default)]
struct SpareInner {
    /// Being built; it reports in once it has painted.
    booting: Option<String>,
    /// Ready to be claimed.
    ready: Option<String>,
}

impl Spares {
    fn lock(&self) -> std::sync::MutexGuard<'_, SpareInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True for the spare window, booting or ready.
    pub fn is_spare(&self, label: &str) -> bool {
        let inner = self.lock();
        inner.booting.as_deref() == Some(label) || inner.ready.as_deref() == Some(label)
    }

    /// Records that `label` is being built as the spare. False when there is one already.
    pub fn start(&self, label: &str) -> bool {
        let mut inner = self.lock();
        if inner.booting.is_some() || inner.ready.is_some() {
            return false;
        }
        inner.booting = Some(label.to_owned());
        true
    }

    /// True when no spare exists or is being built.
    pub fn wanted(&self) -> bool {
        let inner = self.lock();
        inner.booting.is_none() && inner.ready.is_none()
    }

    /// The spare `label` has painted and can be claimed.
    pub fn mark_ready(&self, label: &str) -> bool {
        let mut inner = self.lock();
        if inner.booting.as_deref() != Some(label) {
            return false;
        }
        inner.booting = None;
        inner.ready = Some(label.to_owned());
        true
    }

    /// Takes the ready spare; from now on it is an ordinary window.
    pub fn claim(&self) -> Option<String> {
        self.lock().ready.take()
    }

    /// Takes every spare, booting or ready (to close them).
    pub fn drain(&self) -> Vec<String> {
        let mut inner = self.lock();
        inner
            .booting
            .take()
            .into_iter()
            .chain(inner.ready.take())
            .collect()
    }

    pub fn forget(&self, label: &str) {
        let mut inner = self.lock();
        if inner.booting.as_deref() == Some(label) {
            inner.booting = None;
        }
        if inner.ready.as_deref() == Some(label) {
            inner.ready = None;
        }
    }
}

/// Top-left corner for the dragged window so the grabbed point stays under the cursor.
pub fn follow_position(cursor: (i32, i32), grab: (i32, i32)) -> (i32, i32) {
    (cursor.0 - grab.0, cursor.1 - grab.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(label: &str) -> StripPoint {
        StripPoint {
            label: label.to_owned(),
            x: 10.0,
            y: 5.0,
        }
    }

    #[test]
    fn a_drag_ends_once_and_its_answer_is_taken_once() {
        let drags = WindowDrags::default();
        assert!(drags.begin("window-1"));
        assert!(!drags.begin("window-1"), "one drag per window");
        assert!(drags.is_dragging("window-1"));
        assert_eq!(drags.take("window-1"), None, "no answer while it runs");
        let end = DragEnd {
            target: Some(point("main")),
            cancelled: false,
        };
        drags.finish("window-1", end.clone());
        assert!(!drags.is_dragging("window-1"));
        assert_eq!(drags.take("window-1"), Some(end));
        assert_eq!(drags.take("window-1"), None);
    }

    #[test]
    fn a_new_drag_drops_an_answer_never_taken_and_a_closed_window_is_forgotten() {
        let drags = WindowDrags::default();
        drags.begin("main");
        drags.finish(
            "main",
            DragEnd {
                target: None,
                cancelled: true,
            },
        );
        drags.begin("main");
        drags.finish(
            "main",
            DragEnd {
                target: None,
                cancelled: false,
            },
        );
        assert_eq!(
            drags.take("main"),
            Some(DragEnd {
                target: None,
                cancelled: false
            })
        );
        drags.begin("window-2");
        drags.forget("window-2");
        assert!(!drags.is_dragging("window-2"));
        assert!(drags.begin("window-2"));
    }

    #[test]
    fn only_the_tab_strip_and_a_little_below_it_take_a_tab() {
        assert!(over_strip(5.0, 0.0, 800.0));
        assert!(over_strip(799.0, STRIP_HEIGHT + ATTACH_SLACK - 0.5, 800.0));
        assert!(!over_strip(5.0, STRIP_HEIGHT + ATTACH_SLACK, 800.0));
        assert!(
            !over_strip(5.0, 300.0, 800.0),
            "over the text: not a drop on the tabs"
        );
        assert!(!over_strip(-1.0, 10.0, 800.0));
        assert!(!over_strip(800.0, 10.0, 800.0));
    }

    #[test]
    fn a_snapped_tab_stays_until_pulled_clearly_away() {
        // Snaps in only over the strip, stays a little further out.
        assert!(!over_strip(5.0, -5.0, 800.0));
        assert!(keeps_attached(5.0, -5.0, 800.0));
        assert!(keeps_attached(-20.0, 30.0, 800.0));
        assert!(keeps_attached(
            5.0,
            STRIP_HEIGHT + ATTACH_SLACK + KEEP_MARGIN - 1.0,
            800.0
        ));
        assert!(!keeps_attached(
            5.0,
            STRIP_HEIGHT + ATTACH_SLACK + KEEP_MARGIN,
            800.0
        ));
        assert!(!keeps_attached(5.0, 200.0, 800.0));
        assert!(!keeps_attached(800.0 + KEEP_MARGIN, 10.0, 800.0));
    }

    #[test]
    fn one_spare_window_at_a_time_ready_once_painted_and_claimed_once() {
        let spares = Spares::default();
        assert!(spares.wanted());
        assert!(spares.start("window-5"));
        assert!(!spares.wanted());
        assert!(!spares.start("window-6"), "only one spare");
        assert!(spares.is_spare("window-5"));
        assert_eq!(spares.claim(), None, "not claimable before it painted");
        assert!(!spares.mark_ready("window-6"));
        assert!(spares.mark_ready("window-5"));
        assert_eq!(spares.claim().as_deref(), Some("window-5"));
        assert!(
            !spares.is_spare("window-5"),
            "claimed: an ordinary window now"
        );
        assert_eq!(spares.claim(), None);
        assert!(spares.wanted());
    }

    #[test]
    fn spares_are_dropped_when_closed_or_drained() {
        let spares = Spares::default();
        spares.start("window-2");
        spares.forget("window-2");
        assert!(spares.wanted());
        spares.start("window-3");
        spares.mark_ready("window-3");
        assert_eq!(spares.drain(), vec!["window-3".to_owned()]);
        assert!(spares.wanted());
    }

    #[test]
    fn the_window_keeps_the_grabbed_point_under_the_cursor() {
        assert_eq!(follow_position((1000, 500), (180, 27)), (820, 473));
        assert_eq!(follow_position((10, 5), (180, 27)), (-170, -22));
    }
}
