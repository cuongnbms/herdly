//! The mouse's Back and Forward buttons. WKWebView does not hand them to the page, so a local
//! `NSEvent` monitor catches them and tells the frontend, which moves through its history.
use tauri::AppHandle;

/// Event the frontend listens to; its payload is `"back"` or `"forward"`.
pub const NAV_EVENT: &str = "mouse://nav";

/// The direction of an `otherMouseDown` button, if it is Back (3) or Forward (4).
fn direction(button: isize) -> Option<&'static str> {
    match button {
        3 => Some("back"),
        4 => Some("forward"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{direction, NAV_EVENT};
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    use tauri::{AppHandle, Emitter};

    /// Install the monitor. Must run on the main thread.
    pub fn init(app: &AppHandle) {
        if MainThreadMarker::new().is_none() {
            tracing::error!("mouse::init called off the main thread");
            return;
        }
        let app = app.clone();
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit passes a valid event for the duration of the call.
            let button = unsafe { event.as_ref() }.buttonNumber();
            match direction(button) {
                Some(dir) => {
                    if let Err(e) = app.emit(NAV_EVENT, dir) {
                        tracing::warn!("emit {NAV_EVENT} failed: {e}");
                    }
                    std::ptr::null_mut()
                }
                None => event.as_ptr(),
            }
        });
        // SAFETY: the block returns the event it was given or nil, as the monitor requires.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::OtherMouseDown,
                &block,
            )
        };
        // The monitor lives for the whole process.
        std::mem::forget(monitor);
    }
}

/// Install the Back/Forward monitor. Call once from `setup` (main thread).
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::direction;

    #[test]
    fn back_and_forward_buttons() {
        assert_eq!(direction(3), Some("back"));
        assert_eq!(direction(4), Some("forward"));
        assert_eq!(direction(2), None);
    }
}
