use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::herdr::types::AgentStatus;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineState {
    Disconnected,
    Authenticating,
    Probing,
    Connected,
    Incompatible,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MachineView {
    pub id: String,
    pub label: String,
    /// `"local"` or `"ssh"`.
    pub kind: String,
    pub state: MachineState,
    pub error: Option<AppError>,
    pub version: Option<String>,
    pub pi_agent_dir: Option<String>,
    pub has_pi: bool,
    pub status: AgentStatus,
    pub sessions: Vec<SessionView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionView {
    pub name: String,
    pub running: bool,
    pub status: AgentStatus,
    pub error: Option<AppError>,
    pub workspaces: Vec<WorkspaceView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WorkspaceView {
    pub workspace_id: String,
    pub label: String,
    pub number: u32,
    pub status: AgentStatus,
    pub tabs: Vec<TabView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TabView {
    pub tab_id: String,
    pub label: String,
    pub number: u32,
    pub status: AgentStatus,
    pub panes: Vec<PaneView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PaneView {
    pub pane_id: String,
    pub terminal_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub agent: Option<String>,
    pub status: AgentStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PaneRef {
    pub machine_id: String,
    pub session: String,
    pub pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PaneStatusEvent {
    pub pane: PaneRef,
    pub status: AgentStatus,
    pub previous: AgentStatus,
    pub title: String,
}
