//! The terminal socket's client protocol: one decoded `Command` per client frame.
//!
//! `decode` covers the frames the application protocol defines. Ping, Pong and Close are the
//! socket layer's traffic, not application frames, so the socket answers or ends on them
//! without asking `decode`; only a client frame that this protocol cannot accept becomes a
//! close code here.
use crate::backend::WebPane;
use crate::terminal::backend::TerminalSize;
use axum::extract::ws::Message;
use serde::Deserialize;

/// Close code for a frame this protocol does not accept.
pub const CLOSE_POLICY: u16 = 1008;
/// Close code for a message over its size bound.
pub const CLOSE_OVERSIZED: u16 = 1009;

/// A text control frame carries at most this many bytes.
pub const MAX_CONTROL_TEXT: usize = 16 * 1024;
/// A binary input frame carries at most this many bytes.
pub const MAX_INPUT: usize = 64 * 1024;

/// The smallest and largest character grid the browser may ask for.
pub const MIN_COLS: u16 = 2;
pub const MAX_COLS: u16 = 1000;
pub const MIN_ROWS: u16 = 1;
pub const MAX_ROWS: u16 = 1000;

/// What the client asks for when it opens an attempt.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenRequest {
    pub pane: WebPane,
    pub size: TerminalSize,
    pub takeover: bool,
}

/// One client frame, once the protocol has accepted it.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Open(OpenRequest),
    Input(Vec<u8>),
    Resize(TerminalSize),
    Ack(usize),
    Close,
}

/// The pane a client names. Unknown fields are refused: a browser never contributes a
/// Machine, a Terminal or an argv.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    session: String,
    pane_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Incoming {
    Open {
        pane: Target,
        cols: u16,
        rows: u16,
        takeover: bool,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Ack {
        bytes: usize,
    },
    Close,
}

/// Whether a character grid is one this protocol accepts.
fn grid(cols: u16, rows: u16) -> Result<TerminalSize, u16> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(CLOSE_POLICY);
    }
    Ok(TerminalSize { cols, rows })
}

/// Decodes one client frame, or says which close code rejects it.
pub fn decode(message: Message) -> Result<Command, u16> {
    match message {
        Message::Text(text) => {
            if text.len() > MAX_CONTROL_TEXT {
                return Err(CLOSE_OVERSIZED);
            }
            match serde_json::from_str::<Incoming>(&text) {
                Ok(Incoming::Open {
                    pane,
                    cols,
                    rows,
                    takeover,
                }) => Ok(Command::Open(OpenRequest {
                    pane: WebPane {
                        session: pane.session,
                        pane_id: pane.pane_id,
                    },
                    size: grid(cols, rows)?,
                    takeover,
                })),
                Ok(Incoming::Resize { cols, rows }) => Ok(Command::Resize(grid(cols, rows)?)),
                Ok(Incoming::Ack { bytes }) => Ok(Command::Ack(bytes)),
                Ok(Incoming::Close) => Ok(Command::Close),
                Err(_) => Err(CLOSE_POLICY),
            }
        }
        Message::Binary(bytes) => {
            if bytes.len() > MAX_INPUT {
                return Err(CLOSE_OVERSIZED);
            }
            Ok(Command::Input(bytes.to_vec()))
        }
        // Ping, Pong and Close belong to the socket layer, not to this protocol.
        _ => Err(CLOSE_POLICY),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_flat_open_and_rejects_out_of_range_sizes() {
        use axum::extract::ws::Message;
        let valid = r#"{"type":"open","pane":{"session":"s","pane_id":"p1"},"cols":80,"rows":24,"takeover":false}"#;
        match decode(Message::Text(valid.into())).unwrap() {
            Command::Open(r) => {
                assert_eq!(r.pane.session, "s");
                assert_eq!(r.pane.pane_id, "p1");
                assert_eq!(r.size, TerminalSize { cols: 80, rows: 24 });
                assert!(!r.takeover);
            }
            _ => panic!("not an open"),
        }
        for text in [
            r#"{"type":"resize","cols":1,"rows":24}"#,
            r#"{"type":"resize","cols":80,"rows":0}"#,
            r#"{"type":"resize","cols":1001,"rows":24}"#,
            r#"{"type":"ack","bytes":-1}"#,
            r#"{"type":"bogus"}"#,
        ] {
            assert_eq!(decode(Message::Text(text.into())).unwrap_err(), 1008);
        }
    }

    #[test]
    fn accepts_the_exact_size_boundaries_and_nothing_beyond_them() {
        use axum::extract::ws::Message;
        let open = |cols: u16, rows: u16| {
            format!(
                r#"{{"type":"open","pane":{{"session":"s","pane_id":"p1"}},"cols":{cols},"rows":{rows},"takeover":false}}"#
            )
        };
        for (cols, rows) in [(2, 1), (1000, 1000)] {
            match decode(Message::Text(open(cols, rows).into())).unwrap() {
                Command::Open(r) => assert_eq!(r.size, TerminalSize { cols, rows }),
                other => panic!("expected an open, got {other:?}"),
            }
        }
        assert_eq!(decode(Message::Text(open(1, 24).into())).unwrap_err(), 1008);
        assert_eq!(
            decode(Message::Text(open(1001, 24).into())).unwrap_err(),
            1008
        );
        assert_eq!(decode(Message::Text(open(80, 0).into())).unwrap_err(), 1008);
        assert_eq!(
            decode(Message::Text(open(80, 1001).into())).unwrap_err(),
            1008
        );
    }

    #[test]
    fn enforces_the_text_and_binary_frame_bounds() {
        use axum::extract::ws::Message;
        // A text control frame is bounded in bytes, trailing whitespace included.
        let base = r#"{"type":"ack","bytes":1}"#;
        let padded = |len: usize| {
            assert!(len >= base.len());
            format!("{base}{}", " ".repeat(len - base.len()))
        };
        let at_limit = padded(MAX_CONTROL_TEXT);
        assert_eq!(at_limit.len(), 16 * 1024);
        assert_eq!(
            decode(Message::Text(at_limit.into())).unwrap(),
            Command::Ack(1)
        );
        let over = padded(MAX_CONTROL_TEXT + 1);
        assert_eq!(over.len(), 16 * 1024 + 1);
        assert_eq!(
            decode(Message::Text(over.into())).unwrap_err(),
            CLOSE_OVERSIZED
        );

        // Binary input is bounded at 64 KiB, and one byte over is a close, not a truncation.
        assert_eq!(
            decode(Message::Binary(vec![b'a'; MAX_INPUT].into())).unwrap(),
            Command::Input(vec![b'a'; MAX_INPUT])
        );
        assert_eq!(
            decode(Message::Binary(vec![b'a'; MAX_INPUT + 1].into())).unwrap_err(),
            CLOSE_OVERSIZED
        );
    }

    #[test]
    fn accepts_every_command_and_refuses_unknown_or_missing_fields() {
        use axum::extract::ws::Message;
        let text = |t: &str| decode(Message::Text(t.into()));
        assert_eq!(
            text(r#"{"type":"resize","cols":2,"rows":1000}"#).unwrap(),
            Command::Resize(TerminalSize {
                cols: 2,
                rows: 1000
            })
        );
        assert_eq!(
            text(r#"{"type":"ack","bytes":0}"#).unwrap(),
            Command::Ack(0)
        );
        assert_eq!(
            text(r#"{"type":"ack","bytes":42}"#).unwrap(),
            Command::Ack(42)
        );
        assert_eq!(text(r#"{"type":"close"}"#).unwrap(), Command::Close);
        assert_eq!(
            decode(Message::Binary(vec![0xff, 0x1b, 0x00].into())).unwrap(),
            Command::Input(vec![0xff, 0x1b, 0x00])
        );

        for bad in [
            // A nested size is not the wire shape.
            r#"{"type":"open","pane":{"session":"s","pane_id":"p1"},"size":{"cols":80,"rows":24},"takeover":false}"#,
            // A browser contributes no Machine, Terminal or argv.
            r#"{"type":"open","pane":{"session":"s","pane_id":"p1","machine_id":"m"},"cols":80,"rows":24,"takeover":false}"#,
            r#"{"type":"open","pane":{"session":"s","pane_id":"p1","argv":["sh"]},"cols":80,"rows":24,"takeover":false}"#,
            r#"{"type":"open","pane":{"session":"s","pane_id":"p1"},"cols":80,"rows":24,"takeover":false,"terminal_id":"t"}"#,
            // Missing fields are not defaults.
            r#"{"type":"open","pane":{"session":"s"},"cols":80,"rows":24,"takeover":false}"#,
            r#"{"type":"open","pane":{"session":"s","pane_id":"p1"},"cols":80,"rows":24}"#,
            r#"{"type":"resize","cols":80}"#,
            r#"{"type":"ack"}"#,
            // Malformed JSON is a policy failure, not a panic or a default command.
            r#"{"type":"resize","cols":80,"rows":24"#,
            r#"not json"#,
            // Socket-layer frames are not application commands.
            r#"{}"#,
        ] {
            assert_eq!(text(bad).unwrap_err(), 1008, "{bad}");
        }
    }
}
