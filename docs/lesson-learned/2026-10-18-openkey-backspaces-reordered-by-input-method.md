# OpenKey's Backspaces reached the page after the letter they made room for

**Symptom**: Typing Vietnamese with OpenKey sometimes stopped working everywhere in the
app (Terminal, Chat composer, palette search) until Herdly restarted. Typing `d` again
and again left `d` followed by a run of blank space. English typing was fine. Quitting and
reopening OpenKey did not help; restarting Herdly did. It started right after switching
back to Herdly from another app.

**Root Cause**: OpenKey types `đ` from `dd` by posting key events from its own process:
a U+202F spacer (its "fix browser autocomplete" option), Backspace, Backspace, then `đ`.
A temporary key log showed AppKit delivering them to the WKWebView in that order, but the
page receiving `202F đ ⌫ ⌫`, so the Backspaces deleted the new letter and left the
spacer behind. WKWebView passes each key in an editable field to
`-[NSTextInputContext handleEventByInputMethod:completionHandler:]` and only sends the
key to the web process from that completion. After the window had been inactive, those
completions sometimes came back out of order and stayed that way for the rest of the
process. Before the switch, the same log showed every burst arriving as `202F ⌫ ⌫ đ`.

**Fix**: `src-tauri/src/synthetic_keys.rs`. A local `NSEvent` monitor catches key
events whose CGEvent source is another process (`kCGEventSourceUnixProcessID` not 0 and
not ours). It dispatches them with `-[NSWindow sendEvent:]` while a hook on WebKit's
private `-[WKWebView _web_superInputContext]` returns nil. With no input context, WebKit
takes its synchronous keyboard-layout path, so the keys reach the page in the order they
were posted. Keys from the keyboard, Cmd/Ctrl shortcuts, a field with marked text, and
any input source that is not a plain `com.apple.keylayout.*` layout keep the input method
path, so Apple's own IMEs still compose. A headless WKWebView probe showed the
synchronous path producing the same DOM `keydown`/`input` events and the same `đ`. After
installing the fix, 217 OpenKey bursts across 31 switches back to the app all arrived as
`202F ⌫ ⌫ letter`.

**Lesson**: When typing breaks only with a Vietnamese input tool, log the key order at
both ends (AppKit's local monitor, and capture `keydown`/`beforeinput` in the page)
before suspecting the page. An event-tap IME depends on strict ordering of the keys it
posts, and WKWebView's asynchronous input method round trip does not guarantee it.
