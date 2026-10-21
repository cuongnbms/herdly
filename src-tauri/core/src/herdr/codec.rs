use serde_json::{json, Value};

use super::types::EventFrame;
use crate::error::{AppError, AppResult};

/// One line received from herdr.
#[derive(Clone, Debug, PartialEq)]
pub enum Frame {
    Result {
        id: String,
        result: Value,
    },
    Error {
        id: String,
        code: String,
        message: String,
    },
    Event(EventFrame),
}

/// Encode a request as one JSON object terminated by `\n`.
pub fn encode_request(id: &str, method: &str, params: &Value) -> String {
    let mut s = json!({ "id": id, "method": method, "params": params }).to_string();
    s.push('\n');
    s
}

/// Decode one JSON line from herdr. Non-JSON or unknown shapes are `protocol` errors.
pub fn decode_frame(line: &str) -> AppResult<Frame> {
    let v: Value = serde_json::from_str(line.trim())
        .map_err(|e| AppError::new("protocol", format!("invalid frame: {e}")))?;
    let bad = || AppError::new("protocol", format!("unrecognized frame: {}", line.trim()));
    let obj = v.as_object().ok_or_else(bad)?;

    if let Some(event) = obj.get("event").and_then(Value::as_str) {
        let data = obj.get("data").cloned().unwrap_or(Value::Null);
        return Ok(Frame::Event(EventFrame {
            event: event.to_string(),
            data,
        }));
    }
    let id = match obj.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return Err(bad()),
    };
    if let Some(result) = obj.get("result") {
        return Ok(Frame::Result {
            id,
            result: result.clone(),
        });
    }
    if let Some(err) = obj.get("error") {
        let field = |k: &str| {
            err.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        return Ok(Frame::Error {
            id,
            code: field("code"),
            message: field("message"),
        });
    }
    Err(bad())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn encodes_one_line() {
        let s = encode_request("7", "agent.get", &json!({"target":"w1:p1"}));
        assert!(s.ends_with('\n'));
        assert_eq!(s.matches('\n').count(), 1);
        let v: serde_json::Value = serde_json::from_str(s.trim_end()).unwrap();
        assert_eq!(
            v,
            json!({"id":"7","method":"agent.get","params":{"target":"w1:p1"}})
        );
    }
    #[test]
    fn decodes_result_error_and_event() {
        match decode_frame(r#"{"id":"1","result":{"type":"subscription_started"}}"#).unwrap() {
            Frame::Result { id, result } => {
                assert_eq!(id, "1");
                assert_eq!(result["type"], "subscription_started");
            }
            f => panic!("{f:?}"),
        }
        match decode_frame(r#"{"id":"2","error":{"code":"not_found","message":"no pane w9:p9"}}"#)
            .unwrap()
        {
            Frame::Error { code, message, .. } => {
                assert_eq!(code, "not_found");
                assert_eq!(message, "no pane w9:p9");
            }
            f => panic!("{f:?}"),
        }
        match decode_frame(r#"{"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","workspace_id":"w1","agent_status":"done"}}"#).unwrap() {
            Frame::Event(e) => { assert_eq!(e.event, "pane.agent_status_changed"); assert_eq!(e.data["agent_status"], "done"); }
            f => panic!("{f:?}"),
        }
    }
    #[test]
    fn rejects_garbage() {
        assert_eq!(decode_frame("not json").unwrap_err().code, "protocol");
        assert_eq!(decode_frame(r#"{"hello":1}"#).unwrap_err().code, "protocol");
    }
}
