//! Desktop notifications for agent status changes; clicking one jumps to its pane.
//!
//! On macOS this talks to `NSUserNotificationCenter` directly instead of going through
//! tauri-plugin-notification: the plugin's delegate never answers `shouldPresentNotification:`,
//! so while Herdly is the frontmost app macOS files every notification silently in Notification
//! Center with no banner, and it exposes no click callback to route back to a pane.
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{error::AppError, view::PaneRef};

/// Event the frontend listens to; its payload is the clicked notification's `PaneRef`.
pub const ACTIVATE_EVENT: &str = "notify://activate";

/// Sound names the frontend sends besides a macOS system sound's own name (`Glass`, `Ping`, …).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const DEFAULT_SOUND: &str = "Default";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const NO_SOUND: &str = "None";

/// Bring the main window forward and tell the frontend to select `pane`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn activate<R: Runtime>(app: &AppHandle<R>, pane: PaneRef) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Err(e) = app.emit(ACTIVATE_EVENT, pane) {
        tracing::warn!("emit {ACTIVATE_EVENT} failed: {e}");
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // NSUserNotification: UNUserNotificationCenter needs a properly signed app.
mod mac {
    use super::{activate, PaneRef, DEFAULT_SOUND, NO_SOUND};
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, ProtocolObject},
        AnyThread, ClassType, DefinedClass, MainThreadMarker,
    };
    use objc2_app_kit::NSSound;
    use objc2_foundation::{
        NSDictionary, NSObject, NSObjectProtocol, NSString, NSUserNotification,
        NSUserNotificationCenter, NSUserNotificationCenterDelegate,
        NSUserNotificationDefaultSoundName,
    };
    use tauri::AppHandle;

    const KEYS: [&str; 3] = ["machine_id", "session", "pane_id"];

    pub struct Ivars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and `Delegate` does not implement Drop.
        #[unsafe(super(NSObject))]
        #[name = "HerdlyNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSUserNotificationCenterDelegate for Delegate {
            /// Show the banner even while Herdly is the frontmost app.
            #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
            fn should_present(
                &self,
                _center: &NSUserNotificationCenter,
                _notification: &NSUserNotification,
            ) -> bool {
                true
            }

            #[unsafe(method(userNotificationCenter:didActivateNotification:))]
            fn did_activate(
                &self,
                center: &NSUserNotificationCenter,
                notification: &NSUserNotification,
            ) {
                center.removeDeliveredNotification(notification);
                match pane_of(notification) {
                    Some(pane) => activate(&self.ivars().app, pane),
                    None => tracing::warn!("clicked notification carries no pane"),
                }
            }
        }
    );

    fn pane_of(n: &NSUserNotification) -> Option<PaneRef> {
        let info = n.userInfo()?;
        let get = |k: &str| -> Option<String> {
            let v = info.objectForKey(&NSString::from_str(k))?;
            Some(v.downcast::<NSString>().ok()?.to_string())
        };
        Some(PaneRef {
            machine_id: get(KEYS[0])?,
            session: get(KEYS[1])?,
            pane_id: get(KEYS[2])?,
        })
    }

    /// The default center, or `None` for an unbundled binary (`tauri dev`, `cargo test`): there
    /// it returns nil, which the generated binding treats as a bug and panics on.
    fn center() -> Option<Retained<NSUserNotificationCenter>> {
        unsafe { msg_send![NSUserNotificationCenter::class(), defaultUserNotificationCenter] }
    }

    /// Install the delegate. Must run on the main thread, before the first notification.
    pub fn init(app: &AppHandle) {
        if MainThreadMarker::new().is_none() {
            tracing::error!("notify::init called off the main thread");
            return;
        }
        let Some(center) = center() else {
            tracing::warn!("no notification center (unbundled app); notifications are off");
            return;
        };
        let this = Delegate::alloc().set_ivars(Ivars { app: app.clone() });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(this), init] };
        // SAFETY: the center does not retain its delegate; ours is leaked so it lives for the
        // whole process.
        unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
        std::mem::forget(delegate);
    }

    /// Deliver one notification. Must run on the main thread.
    pub fn deliver(pane: &PaneRef, title: &str, body: &str, sound: &str) {
        match center() {
            Some(center) => center.deliverNotification(&build(pane, title, body, sound)),
            None => tracing::debug!("no notification center; dropped \"{title}\""),
        }
    }

    /// A notification whose `userInfo` carries `pane`, read back by [`pane_of`] on click.
    fn build(pane: &PaneRef, title: &str, body: &str, sound: &str) -> Retained<NSUserNotification> {
        let n = NSUserNotification::new();
        n.setTitle(Some(&NSString::from_str(title)));
        n.setInformativeText(Some(&NSString::from_str(body)));
        // A nil sound name (NSUserNotification's default) delivers silently.
        match sound {
            NO_SOUND => {}
            DEFAULT_SOUND => n.setSoundName(Some(unsafe { NSUserNotificationDefaultSoundName })),
            name => n.setSoundName(Some(&NSString::from_str(name))),
        }
        let keys = KEYS.map(NSString::from_str);
        let vals = [&pane.machine_id, &pane.session, &pane.pane_id].map(|s| NSString::from_str(s));
        let info = NSDictionary::<NSString, AnyObject>::from_slices(
            &keys.each_ref().map(|k| &**k),
            &vals.each_ref().map(|v| -> &AnyObject { v.as_ref() }),
        );
        // SAFETY: every value is an NSString, a valid property-list type.
        unsafe { n.setUserInfo(Some(&info)) };
        n
    }

    /// Play a system sound by name, for previewing it in Settings. Must run on the main thread.
    pub fn play(sound: &str) {
        match NSSound::soundNamed(&NSString::from_str(sound)) {
            Some(s) => {
                s.play();
            }
            None => tracing::debug!("no system sound named \"{sound}\""),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pane_roundtrips_through_user_info() {
            let pane = PaneRef {
                machine_id: "devtuf".into(),
                session: "my session".into(),
                pane_id: "w5:p1E".into(),
            };
            let n = build(
                &pane,
                "claude is blocked",
                "devtuf › my session › app",
                DEFAULT_SOUND,
            );
            assert_eq!(pane_of(&n), Some(pane));
            assert_eq!(n.title().unwrap().to_string(), "claude is blocked");
        }

        fn sound_of(sound: &str) -> Option<String> {
            let pane = PaneRef {
                machine_id: "m".into(),
                session: "s".into(),
                pane_id: "p".into(),
            };
            build(&pane, "title", "body", sound)
                .soundName()
                .map(|s| s.to_string())
        }

        #[test]
        fn default_sound_is_the_system_notification_sound() {
            let default = unsafe { NSUserNotificationDefaultSoundName }.to_string();
            assert_eq!(sound_of(DEFAULT_SOUND), Some(default));
        }

        #[test]
        fn named_sound_is_played_by_name() {
            assert_eq!(sound_of("Glass"), Some("Glass".into()));
        }

        #[test]
        fn no_sound_delivers_silently() {
            assert_eq!(sound_of(NO_SOUND), None);
        }

        /// `cargo test` runs unbundled, like `tauri dev`: there is no default center there.
        #[test]
        fn deliver_without_a_center_does_not_panic() {
            let pane = PaneRef {
                machine_id: "m".into(),
                session: "s".into(),
                pane_id: "p".into(),
            };
            deliver(&pane, "title", "body", DEFAULT_SOUND);
        }

        #[test]
        fn notification_without_pane_is_ignored() {
            assert_eq!(pane_of(&NSUserNotification::new()), None);
        }
    }
}

/// Install the click handler. Call once from `setup` (main thread).
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::init(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Show a notification for `pane` with `sound` (`Default`, `None` or a system sound's name);
/// clicking it selects that pane. Both the pane jump and the sound are macOS only.
pub fn show(
    app: &AppHandle,
    pane: PaneRef,
    title: String,
    body: String,
    sound: String,
) -> Result<(), AppError> {
    show_inner(app, pane, title, body, sound).map_err(|e| AppError::new("io", e.to_string()))
}

/// Play the system sound `sound` once, so Settings can preview it (macOS only).
pub fn preview_sound(app: &AppHandle, sound: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    let r = app.run_on_main_thread(move || mac::play(&sound));
    #[cfg(not(target_os = "macos"))]
    let r: tauri::Result<()> = {
        let _ = (app, sound);
        Ok(())
    };
    r.map_err(|e| AppError::new("io", e.to_string()))
}

fn show_inner(
    app: &AppHandle,
    pane: PaneRef,
    title: String,
    body: String,
    sound: String,
) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || mac::deliver(&pane, &title, &body, &sound))
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = (pane, sound);
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| tauri::Error::Anyhow(e.into()))
    }
}
