use serde::Serialize;

/// The single error type of the app. Serialized to the UI as `{ "code", "message" }`.
///
/// Allowed codes: `herdr_error`, `timeout`, `io`, `protocol`, `ssh_auth`,
/// `ssh_forward_denied`, `herdr_not_found`, `incompatible`, `attach_held`,
/// `not_found`, `invalid`, `conflict`.
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new("io", e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn displays_code_and_message() {
        let e = AppError::new("timeout", "session.snapshot took longer than 10s");
        assert_eq!(
            e.to_string(),
            "timeout: session.snapshot took longer than 10s"
        );
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"code":"timeout","message":"session.snapshot took longer than 10s"})
        );
    }
    #[test]
    fn io_errors_map_to_io() {
        let e: AppError = std::io::Error::new(std::io::ErrorKind::NotFound, "nope").into();
        assert_eq!(e.code, "io");
    }
}
