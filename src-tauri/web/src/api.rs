//! REST handlers under `/api`.
use crate::app::AppState;
use crate::auth::DeviceInfo;
use crate::backend::WebPane;
use crate::error::{status_for, ApiError};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{FromRequest, Query, Request, State};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use herdly_core::error::AppError;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type St = State<Arc<AppState>>;

/// Largest page of chat items a client may ask for.
const PAGE_MAX: usize = 200;

/// A malformed body or query is an `invalid` AppError; an oversized body keeps its 413.
pub struct BadInput(Response);

impl IntoResponse for BadInput {
    fn into_response(self) -> Response {
        self.0
    }
}

fn bad_input(status: axum::http::StatusCode, message: String) -> BadInput {
    let status =
        if status.is_client_error() && status != axum::http::StatusCode::UNPROCESSABLE_ENTITY {
            status
        } else {
            status_for("invalid")
        };
    BadInput((status, Json(AppError::new("invalid", message))).into_response())
}

impl From<JsonRejection> for BadInput {
    fn from(r: JsonRejection) -> Self {
        bad_input(r.status(), r.body_text())
    }
}

impl From<QueryRejection> for BadInput {
    fn from(r: QueryRejection) -> Self {
        bad_input(r.status(), r.body_text())
    }
}

/// A JSON request body whose rejections are AppError JSON.
pub struct Body<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for Body<T> {
    type Rejection = BadInput;

    async fn from_request(req: Request, state: &S) -> Result<Self, BadInput> {
        let Json(v) = Json::<T>::from_request(req, state).await?;
        Ok(Body(v))
    }
}

#[derive(Deserialize)]
pub struct PaneBody {
    session: String,
    pane_id: String,
}

#[derive(Deserialize)]
pub struct TextBody {
    session: String,
    pane_id: String,
    text: String,
}

#[derive(Deserialize)]
pub struct KeysBody {
    session: String,
    pane_id: String,
    keys: Vec<String>,
}

#[derive(Deserialize)]
pub struct PageQuery {
    session: String,
    pane_id: String,
    before: usize,
    limit: usize,
}

pub async fn me(Extension(info): Extension<DeviceInfo>) -> Json<DeviceInfo> {
    Json(info)
}

pub async fn machines(State(st): St) -> Response {
    Json(st.backend.views()).into_response()
}

pub async fn chat_page(
    State(st): St,
    q: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Response, Response> {
    let Query(q) = q.map_err(|r| BadInput::from(r).into_response())?;
    let pane = WebPane {
        session: q.session,
        pane_id: q.pane_id,
    };
    match st.backend.page(&pane, q.before, q.limit.min(PAGE_MAX)) {
        Some(items) => Ok(Json(items).into_response()),
        None => Err(ApiError(AppError::new("not_found", "no open chat")).into_response()),
    }
}

pub async fn pane_read(State(st): St, Body(b): Body<PaneBody>) -> Result<Json<Value>, ApiError> {
    let r = st
        .backend
        .call(
            &b.session,
            "pane.read",
            json!({"pane_id": b.pane_id, "source": "visible", "format": "text", "strip_ansi": true}),
        )
        .await?;
    let text = r["text"]
        .as_str()
        .or_else(|| r["read"]["text"].as_str())
        .unwrap_or("");
    Ok(Json(json!({ "text": text })))
}

pub async fn pane_prompt(State(st): St, Body(b): Body<TextBody>) -> Result<Json<Value>, ApiError> {
    st.backend
        .call(
            &b.session,
            "agent.prompt",
            json!({"target": b.pane_id, "text": b.text}),
        )
        .await?;
    Ok(Json(json!({})))
}

pub async fn pane_keys(State(st): St, Body(b): Body<KeysBody>) -> Result<Json<Value>, ApiError> {
    st.backend
        .call(
            &b.session,
            "agent.send_keys",
            json!({"target": b.pane_id, "keys": b.keys}),
        )
        .await?;
    Ok(Json(json!({})))
}

pub async fn pane_text(State(st): St, Body(b): Body<TextBody>) -> Result<Json<Value>, ApiError> {
    st.backend
        .call(
            &b.session,
            "pane.send_text",
            json!({"pane_id": b.pane_id, "text": b.text}),
        )
        .await?;
    Ok(Json(json!({})))
}
