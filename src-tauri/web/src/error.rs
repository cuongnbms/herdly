//! HTTP error mapping: every error body is core's `AppError` JSON.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use herdly_core::error::AppError;

pub fn status_for(code: &str) -> StatusCode {
    match code {
        "not_found" => StatusCode::NOT_FOUND,
        "invalid" => StatusCode::BAD_REQUEST,
        "conflict" => StatusCode::CONFLICT,
        "timeout" => StatusCode::GATEWAY_TIMEOUT,
        "unauthorized" => StatusCode::UNAUTHORIZED,
        "forbidden" => StatusCode::FORBIDDEN,
        _ => StatusCode::BAD_GATEWAY,
    }
}

pub struct ApiError(pub AppError);

impl From<AppError> for ApiError {
    fn from(e: AppError) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (status_for(&self.0.code), Json(self.0)).into_response()
    }
}

pub fn unauthorized() -> ApiError {
    ApiError(AppError::new("unauthorized", "not paired"))
}

pub fn forbidden(msg: &str) -> ApiError {
    ApiError(AppError::new("forbidden", msg))
}
