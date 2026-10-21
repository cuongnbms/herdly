use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    #[default]
    #[serde(other)]
    Unknown,
}

impl AgentStatus {
    /// Higher is more urgent: blocked 4, working 3, done 2, idle 1, unknown 0.
    pub fn urgency(self) -> u8 {
        match self {
            AgentStatus::Blocked => 4,
            AgentStatus::Working => 3,
            AgentStatus::Done => 2,
            AgentStatus::Idle => 1,
            AgentStatus::Unknown => 0,
        }
    }

    /// The most urgent status of `it`; `Unknown` when empty.
    pub fn rollup<I: IntoIterator<Item = AgentStatus>>(it: I) -> AgentStatus {
        it.into_iter()
            .max_by_key(|s| s.urgency())
            .unwrap_or(AgentStatus::Unknown)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub version: String,
    pub protocol: u32,
    pub workspaces: Vec<WorkspaceInfo>,
    pub tabs: Vec<TabInfo>,
    pub panes: Vec<PaneInfo>,
    pub agents: Vec<AgentInfo>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub label: String,
    pub number: u32,
    pub agent_status: AgentStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    pub label: String,
    pub number: u32,
    pub agent_status: AgentStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PaneInfo {
    pub pane_id: String,
    pub tab_id: String,
    pub workspace_id: String,
    pub terminal_id: String,
    /// The user-set pane name (`pane.rename`).
    pub label: Option<String>,
    pub cwd: Option<String>,
    pub foreground_cwd: Option<String>,
    pub terminal_title_stripped: Option<String>,
    pub agent_status: AgentStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentInfo {
    pub pane_id: String,
    pub agent: Option<String>,
    pub agent_status: AgentStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventFrame {
    pub event: String,
    pub data: Value,
}

/// Data of a `pane.agent_status_changed` event; extra fields are ignored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentStatusChanged {
    pub pane_id: String,
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub agent: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Snapshot {
        serde_json::from_str(include_str!("../../tests/fixtures/snapshot.json")).unwrap()
    }
    #[test]
    fn parses_snapshot_and_unknown_status() {
        let s = fixture();
        assert_eq!(s.protocol, 22);
        assert_eq!(s.panes.len(), 4);
        assert_eq!(s.panes[3].agent_status, AgentStatus::Unknown);
        assert_eq!(s.agents[1].agent.as_deref(), Some("pi"));
        assert_eq!(s.panes[0].cwd.as_deref(), Some("/Users/me/herdr app"));
    }
    #[test]
    fn rollup_picks_most_urgent() {
        use AgentStatus::*;
        assert_eq!(AgentStatus::rollup([Idle, Done, Working]), Working);
        assert_eq!(AgentStatus::rollup([Working, Blocked, Idle]), Blocked);
        assert_eq!(AgentStatus::rollup([]), Unknown);
        assert_eq!(AgentStatus::rollup([Unknown, Idle]), Idle);
    }
}
