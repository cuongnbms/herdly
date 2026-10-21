use axum::{http::StatusCode, response::IntoResponse};
use herdly_core::error::AppError;
use herdly_web::error::{status_for, unauthorized, ApiError};

#[test]
fn codes_map_to_statuses() {
    assert_eq!(status_for("not_found"), StatusCode::NOT_FOUND);
    assert_eq!(status_for("invalid"), StatusCode::BAD_REQUEST);
    assert_eq!(status_for("conflict"), StatusCode::CONFLICT);
    assert_eq!(status_for("timeout"), StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(status_for("unauthorized"), StatusCode::UNAUTHORIZED);
    assert_eq!(status_for("forbidden"), StatusCode::FORBIDDEN);
    assert_eq!(status_for("herdr_error"), StatusCode::BAD_GATEWAY);
    assert_eq!(status_for("io"), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn api_error_body_is_the_app_error() {
    let res = ApiError(AppError::new("not_found", "unknown pane p9")).into_response();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = http_body_util::BodyExt::collect(res.into_body()).await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v, serde_json::json!({"code": "not_found", "message": "unknown pane p9"}));
    let res = unauthorized().into_response();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
