//! Keys another process posts (OpenKey, EVKey and other Vietnamese input tools) reach the page
//! in the order they were posted.
//!
//! Such a tool types `đ` by posting Backspace, Backspace, `đ` (after a U+202F spacer). WKWebView
//! hands every key in an editable field to the input method with the asynchronous
//! `-[NSTextInputContext handleEventByInputMethod:completionHandler:]` and sends it to the page
//! only from that completion. After the window has been inactive, those completions sometimes
//! come back out of order and stay that way until the app restarts: the page then got
//! `202F đ ⌫ ⌫` instead of `202F ⌫ ⌫ đ`, so the Backspaces ate the new letter.
//!
//! A local monitor re-dispatches posted keys itself while WebKit's private
//! `-[WKWebView _web_superInputContext]` returns nil, which sends WebKit down its synchronous
//! keyboard-layout path (the one it uses for non-editable content). Only plain keyboard layouts
//! are bypassed, so an Apple input method (Japanese, Vietnamese Telex, …) keeps its composition.
use std::sync::atomic::{AtomicBool, Ordering};

/// What decides whether a key event skips the input method.
pub struct KeyFacts<'a> {
    /// `kCGEventSourceUnixProcessID`: 0 for the keyboard, otherwise the process that posted it.
    pub source_pid: i64,
    pub own_pid: i64,
    /// Command or Control held: a shortcut, which the normal path must see.
    pub shortcut: bool,
    /// The webview's input context's selected keyboard input source, `None` without one.
    pub input_source: Option<&'a str>,
    pub has_marked_text: bool,
}

/// Whether the key was posted by another process to a plain layout with nothing being composed.
pub fn should_bypass(f: &KeyFacts) -> bool {
    f.source_pid != 0
        && f.source_pid != f.own_pid
        && !f.shortcut
        && !f.has_marked_text
        && f.input_source
            .is_some_and(|s| s.starts_with("com.apple.keylayout."))
}

/// True only while the monitor re-dispatches a bypassed key.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static BYPASS: AtomicBool = AtomicBool::new(false);

/// Clears `BYPASS` even if dispatching unwinds, so the input method is never left off.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Bypassing;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl Bypassing {
    fn start() -> Self {
        BYPASS.store(true, Ordering::Relaxed);
        Bypassing
    }
}

impl Drop for Bypassing {
    fn drop(&mut self) {
        BYPASS.store(false, Ordering::Relaxed);
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{should_bypass, Bypassing, KeyFacts, BYPASS};
    use block2::RcBlock;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use objc2_core_graphics::{CGEvent, CGEventField};
    use objc2_foundation::NSString;
    use std::ptr::NonNull;
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;

    type InputContextFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject;

    /// WebKit's own `_web_superInputContext`, called whenever no key is being bypassed.
    static ORIGINAL: OnceLock<InputContextFn> = OnceLock::new();

    unsafe extern "C-unwind" fn input_context(this: *mut AnyObject, cmd: Sel) -> *mut AnyObject {
        if BYPASS.load(Ordering::Relaxed) {
            return std::ptr::null_mut();
        }
        match ORIGINAL.get() {
            // SAFETY: the original implementation of this very method, with its own arguments.
            Some(original) => unsafe { original(this, cmd) },
            None => std::ptr::null_mut(),
        }
    }

    /// Replaces `-[WKWebView _web_superInputContext]`; false when WebKit no longer has it.
    fn hook_input_context() -> bool {
        let Some(class) = AnyClass::get(c"WKWebView") else {
            return false;
        };
        let Some(method) = class.instance_method(sel!(_web_superInputContext)) else {
            return false;
        };
        // SAFETY: the replacement has the method's signature (`id (id, SEL)`); the original is
        // kept before anything can call the replacement.
        unsafe {
            let ours: Imp = std::mem::transmute::<InputContextFn, Imp>(input_context);
            let original = method.set_implementation(ours);
            let _ = ORIGINAL.set(std::mem::transmute::<Imp, InputContextFn>(original));
        }
        true
    }

    pub fn init() {
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::error!("synthetic_keys::init called off the main thread");
            return;
        };
        if !hook_input_context() {
            tracing::warn!(
                "WKWebView has no _web_superInputContext; posted keys keep the input method path"
            );
            return;
        }
        let own_pid = i64::from(std::process::id());
        let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit passes a valid event for the duration of the call.
            let e = unsafe { event.as_ref() };
            if BYPASS.load(Ordering::Relaxed) {
                return event.as_ptr();
            }
            let Some(window) = e.window(mtm) else {
                return event.as_ptr();
            };
            if !window.isKeyWindow() {
                return event.as_ptr();
            }
            let Some(responder) = window.firstResponder() else {
                return event.as_ptr();
            };
            let view: &AnyObject = &responder;
            // SAFETY: respondsToSelector: takes a selector and returns BOOL.
            let is_webview: bool =
                unsafe { msg_send![view, respondsToSelector: sel!(_web_superInputContext)] };
            if !is_webview {
                return event.as_ptr();
            }
            let source_pid = e
                .CGEvent()
                .map(|cg| {
                    CGEvent::integer_value_field(Some(&cg), CGEventField::EventSourceUnixProcessID)
                })
                .unwrap_or(0);
            // Cheap checks first: the keyboard's own keys never need the input context read.
            if source_pid == 0 || source_pid == own_pid {
                return event.as_ptr();
            }
            // SAFETY: inputContext returns an NSTextInputContext or nil; selectedKeyboardInputSource
            // an NSString or nil; hasMarkedText a BOOL.
            let (input_source, has_marked_text) = unsafe {
                let context: *mut AnyObject = msg_send![view, inputContext];
                let source = match context.as_ref() {
                    Some(c) => {
                        let s: *mut NSString = msg_send![c, selectedKeyboardInputSource];
                        s.as_ref().map(|s| s.to_string())
                    }
                    None => None,
                };
                let marked: bool = msg_send![view, hasMarkedText];
                (source, marked)
            };
            let flags = e.modifierFlags();
            let facts = KeyFacts {
                source_pid,
                own_pid,
                shortcut: flags.contains(NSEventModifierFlags::Command)
                    || flags.contains(NSEventModifierFlags::Control),
                input_source: input_source.as_deref(),
                has_marked_text,
            };
            if !should_bypass(&facts) {
                return event.as_ptr();
            }
            // -[NSWindow sendEvent:] does not run local monitors again, so this is not recursive.
            let _bypassing = Bypassing::start();
            window.sendEvent(e);
            std::ptr::null_mut()
        });
        // SAFETY: the block returns the event it was given, or nil for one it dispatched itself.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown | NSEventMask::KeyUp,
                &block,
            )
        };
        // The monitor lives for the whole process.
        std::mem::forget(monitor);
    }
}

/// Install the hook and monitor. Call once from `setup` (main thread).
pub fn init() {
    #[cfg(target_os = "macos")]
    mac::init();
}

#[cfg(test)]
mod tests {
    use super::{should_bypass, KeyFacts};

    fn facts() -> KeyFacts<'static> {
        KeyFacts {
            source_pid: 4242,
            own_pid: 100,
            shortcut: false,
            input_source: Some("com.apple.keylayout.ABC"),
            has_marked_text: false,
        }
    }

    #[test]
    fn a_key_another_process_posted_to_a_plain_layout_skips_the_input_method() {
        assert!(should_bypass(&facts()));
    }

    #[test]
    fn keyboard_and_own_keys_keep_the_input_method() {
        assert!(!should_bypass(&KeyFacts {
            source_pid: 0,
            ..facts()
        }));
        assert!(!should_bypass(&KeyFacts {
            source_pid: 100,
            ..facts()
        }));
    }

    #[test]
    fn shortcuts_compositions_and_input_methods_keep_the_input_method() {
        assert!(!should_bypass(&KeyFacts {
            shortcut: true,
            ..facts()
        }));
        assert!(!should_bypass(&KeyFacts {
            has_marked_text: true,
            ..facts()
        }));
        assert!(!should_bypass(&KeyFacts {
            input_source: Some("com.apple.inputmethod.VietnameseIM.VietnameseSimpleTelex"),
            ..facts()
        }));
        assert!(!should_bypass(&KeyFacts {
            input_source: None,
            ..facts()
        }));
    }
}
