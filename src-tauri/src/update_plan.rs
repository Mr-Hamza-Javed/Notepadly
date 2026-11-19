//! The decisions of the auto-updater, apart from Tauri and the network, so they
//! can be tested with stubs (BUGS.md 1.5): what a check leads to, when a
//! download goes in, and what an install does. `autoupdate.rs` does the I/O.

use serde::Serialize;
use std::future::Future;
use std::time::Duration;

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
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

/// Whether a check may start: not while another runs, and not when a
/// downloaded update is already waiting to go in.
pub fn may_start_check(update_waiting: bool, already_checking: bool) -> bool {
    !update_waiting && !already_checking
}

/// The rest of a check once the release feed has answered. `found` is the feed's
/// answer: the newer version and its handle, none, or an error. A newer version
/// is downloaded (`download` verifies the signature) only by an installed copy;
/// the portable exe just reports it. `set` receives each status change. Returns
/// the handle and bytes to keep for installing.
pub async fn check_and_download<R, D, Fut>(
    found: Result<Option<(String, R)>, String>,
    installed: bool,
    download: D,
    set: &mut dyn FnMut(Phase, Option<String>),
) -> Result<Option<(R, Vec<u8>)>, String>
where
    D: FnOnce(&R) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, String>>,
{
    let Some((version, release)) = found? else {
        set(Phase::UpToDate, None);
        return Ok(None);
    };
    if !installed {
        set(Phase::Available, Some(version));
        return Ok(None);
    }
    set(Phase::Downloading, Some(version.clone()));
    let bytes = download(&release).await?;
    set(Phase::Ready, Some(version));
    Ok(Some((release, bytes)))
}

/// After a check: an update that is waiting while no window is on screen (the
/// app is in the background, so nothing can be lost) installs right away.
pub fn install_after_check(update_waiting: bool, window_on_screen: bool) -> bool {
    update_waiting && !window_on_screen
}

#[derive(PartialEq, Eq, Debug)]
pub enum InstallPlan {
    /// No downloaded update.
    Nothing,
    /// The user turned updates off after the download: keep the bytes (turning
    /// updates back on installs them) but do not install.
    Keep,
    /// Install; `marker` writes the resume marker first, so the restarted app
    /// starts hidden.
    Install { marker: bool },
}

/// What `install_if_ready` does.
pub fn install_plan(
    may_install: bool,
    has_download: bool,
    relaunch_hidden: bool,
    marker_path_known: bool,
) -> InstallPlan {
    match (has_download, may_install) {
        (false, _) => InstallPlan::Nothing,
        (true, false) => InstallPlan::Keep,
        (true, true) => InstallPlan::Install {
            marker: relaunch_hidden && marker_path_known,
        },
    }
}

/// The delay before the first check: `NOTEPADLY_UPDATE_FIRST_CHECK_SECS` when it
/// is a whole number of seconds, else `default`. Split into the wait before the
/// file-icon job (at most 5 s) and the rest.
pub fn first_check_delays(env: Option<&str>, default: Duration) -> (Duration, Duration) {
    let first = env
        .and_then(|s| s.trim().parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(default);
    let settle = Duration::from_secs(5).min(first);
    (settle, first - settle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    /// Runs a future whose awaits are all ready at once (the stubs below).
    fn run<F: Future>(future: F) -> F::Output {
        let mut context = Context::from_waker(Waker::noop());
        let mut future = pin!(future);
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut context) {
                return output;
            }
        }
    }

    type Log = Vec<(Phase, Option<String>)>;
    type Kept = Result<Option<(&'static str, Vec<u8>)>, String>;

    fn check(
        found: Result<Option<(String, &'static str)>, String>,
        installed: bool,
        download: Result<Vec<u8>, String>,
    ) -> (Kept, Log, bool) {
        let mut log = Vec::new();
        let downloaded = Cell::new(false);
        let result = run(check_and_download(
            found,
            installed,
            |release: &&'static str| {
                assert_eq!(*release, "handle");
                downloaded.set(true);
                std::future::ready(download)
            },
            &mut |phase, version| log.push((phase, version)),
        ));
        (result, log, downloaded.get())
    }

    #[test]
    fn no_newer_version_is_up_to_date_and_downloads_nothing() {
        let (result, log, downloaded) = check(Ok(None), true, Ok(vec![1]));
        assert_eq!(result, Ok(None));
        assert_eq!(log, vec![(Phase::UpToDate, None)]);
        assert!(!downloaded);
    }

    #[test]
    fn an_installed_copy_downloads_a_newer_version_and_keeps_it() {
        let found = Ok(Some(("1.2.0".to_owned(), "handle")));
        let (result, log, downloaded) = check(found, true, Ok(vec![7, 8]));
        assert_eq!(result, Ok(Some(("handle", vec![7, 8]))));
        assert!(downloaded);
        assert_eq!(
            log,
            vec![
                (Phase::Downloading, Some("1.2.0".into())),
                (Phase::Ready, Some("1.2.0".into())),
            ]
        );
    }

    #[test]
    fn the_portable_exe_only_reports_a_newer_version() {
        let found = Ok(Some(("1.2.0".to_owned(), "handle")));
        let (result, log, downloaded) = check(found, false, Ok(vec![1]));
        assert_eq!(result, Ok(None));
        assert_eq!(log, vec![(Phase::Available, Some("1.2.0".into()))]);
        assert!(!downloaded);
    }

    #[test]
    fn feed_and_download_errors_are_returned_and_keep_nothing() {
        let (result, log, _) = check(Err("offline".into()), true, Ok(vec![1]));
        assert_eq!(result, Err("offline".into()));
        assert!(log.is_empty());

        // A bad signature fails the download: nothing is kept to install.
        let found = Ok(Some(("1.2.0".to_owned(), "handle")));
        let (result, log, _) = check(found, true, Err("signature".into()));
        assert_eq!(result, Err("signature".into()));
        assert_eq!(log, vec![(Phase::Downloading, Some("1.2.0".into()))]);
    }

    #[test]
    fn checks_do_not_overlap_or_repeat_a_waiting_download() {
        assert!(may_start_check(false, false));
        assert!(!may_start_check(true, false));
        assert!(!may_start_check(false, true));
    }

    #[test]
    fn a_waiting_update_installs_after_a_check_only_in_the_background() {
        assert!(install_after_check(true, false));
        assert!(!install_after_check(true, true));
        assert!(!install_after_check(false, false));
    }

    // BUGS.md H13: turning updates off after the download must stop the install.
    #[test]
    fn install_plan_follows_the_setting_and_the_marker() {
        assert_eq!(install_plan(true, false, true, true), InstallPlan::Nothing);
        assert_eq!(install_plan(false, true, true, true), InstallPlan::Keep);
        assert_eq!(
            install_plan(true, true, true, true),
            InstallPlan::Install { marker: true }
        );
        // On exit the restarted app shows normally: no marker.
        assert_eq!(
            install_plan(true, true, false, true),
            InstallPlan::Install { marker: false }
        );
        assert_eq!(
            install_plan(true, true, true, false),
            InstallPlan::Install { marker: false }
        );
    }

    #[test]
    fn the_first_check_delay_can_be_overridden() {
        let default = Duration::from_secs(45);
        let secs = |d: (Duration, Duration)| (d.0.as_secs(), d.1.as_secs());
        assert_eq!(secs(first_check_delays(None, default)), (5, 40));
        assert_eq!(secs(first_check_delays(Some("2"), default)), (2, 0));
        assert_eq!(secs(first_check_delays(Some(" 60 "), default)), (5, 55));
        assert_eq!(secs(first_check_delays(Some("soon"), default)), (5, 40));
    }
}
