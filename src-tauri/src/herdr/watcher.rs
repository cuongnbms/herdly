//! Per-session watcher: keeps a `SessionView` fresh from herdr's event stream.
use super::{
    model::{apply_status, pane_ids, session_view, DoneMarks},
    rpc::{self, Subscription},
    types::{AgentStatus, AgentStatusChanged, EventFrame, Snapshot},
};
use crate::{
    error::{AppError, AppResult},
    view::SessionView,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    sync::{mpsc::UnboundedSender, Notify},
    task::JoinHandle,
    time::{timeout_at, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug)]
pub enum WatchEvent {
    View(SessionView),
    Status {
        pane_id: String,
        status: AgentStatus,
        previous: AgentStatus,
        title: String,
    },
    Closed(AppError),
}

/// Events answered with a refetch. `pane.updated` carries renames and terminal title changes.
pub const STRUCTURAL: [&str; 14] = [
    "workspace.created",
    "workspace.updated",
    "workspace.closed",
    "workspace.renamed",
    "workspace.reordered",
    "tab.created",
    "tab.closed",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.closed",
    "pane.exited",
    "pane.moved",
    "pane.updated",
];

fn closed() -> AppError {
    AppError::new("io", "herdr session closed")
}

/// A Session's `DoneMarks`, shared by its watcher and the app's own `pane.focus` calls.
#[derive(Default)]
pub struct SharedMarks {
    marks: Mutex<DoneMarks>,
    /// Woken when the marks changed outside the watcher.
    changed: Notify,
}

impl SharedMarks {
    /// The app focused `pane_id`: it shows idle from now on. Call before the `pane.focus`
    /// reaches herdr, so the done → idle herdr answers with is taken as our own seen.
    pub fn app_focused(&self, pane_id: &str) {
        self.lock().on_focus(pane_id);
        self.changed.notify_one();
    }

    fn lock(&self) -> MutexGuard<'_, DoneMarks> {
        self.marks.lock().unwrap()
    }
}

async fn subscribe_all(socket: &Path, snap: &Snapshot) -> AppResult<Subscription> {
    let mut subs: Vec<Value> = STRUCTURAL.iter().map(|t| json!({ "type": t })).collect();
    subs.extend(
        pane_ids(snap)
            .into_iter()
            .map(|id| json!({ "type": "pane.agent_status_changed", "pane_id": id })),
    );
    rpc::subscribe(socket, subs).await
}

enum Handled {
    Done,
    /// Unparseable or unknown-pane status event: refetch instead of patching.
    Refetch,
    Gone,
}

/// One watcher run: the snapshot herdr last described, and the view last sent.
struct Watch<'a> {
    name: &'a str,
    snap: Snapshot,
    last: SessionView,
    marks: &'a SharedMarks,
    tx: &'a UnboundedSender<WatchEvent>,
}

impl Watch<'_> {
    fn view(&self) -> SessionView {
        session_view(self.name, &self.snap, &self.marks.lock())
    }

    /// Send the view when it differs from the last one sent; `false` once the receiver is gone.
    fn send_view(&mut self) -> bool {
        let view = self.view();
        if view == self.last {
            return true;
        }
        self.last = view.clone();
        self.tx.send(WatchEvent::View(view)).is_ok()
    }

    /// Apply a status event; send `View` if anything shows differently, then `Status` if the
    /// status the app shows changed.
    fn handle_status(&mut self, ev: &EventFrame) -> Handled {
        let Ok(change) = serde_json::from_value::<AgentStatusChanged>(ev.data.clone()) else {
            tracing::warn!(
                "malformed pane.agent_status_changed, refetching: {}",
                ev.data
            );
            return Handled::Refetch;
        };
        if !self.snap.panes.iter().any(|p| p.pane_id == change.pane_id) {
            return Handled::Refetch;
        }
        let applied = apply_status(&mut self.snap, &change);
        if !applied.changed {
            return Handled::Done;
        }
        let (previous, status) = {
            let mut marks = self.marks.lock();
            let raw_previous = applied.previous.unwrap_or(change.agent_status);
            let previous = marks.status(&change.pane_id, raw_previous);
            if let Some(raw_previous) = applied.previous {
                marks.on_status(&change.pane_id, raw_previous, change.agent_status);
            }
            (previous, marks.status(&change.pane_id, change.agent_status))
        };
        if !self.send_view() {
            return Handled::Gone;
        }
        // An agent-only change, or a seen of herdr's that we keep done: no transition (no notification).
        if previous == status {
            return Handled::Done;
        }
        let title = self
            .last
            .workspaces
            .iter()
            .flat_map(|w| &w.tabs)
            .flat_map(|t| &t.panes)
            .find(|p| p.pane_id == change.pane_id)
            .map(|p| p.title.clone())
            .unwrap_or_else(|| change.pane_id.clone());
        let sent = self
            .tx
            .send(WatchEvent::Status {
                pane_id: change.pane_id,
                status,
                previous,
                title,
            })
            .is_ok();
        if sent {
            Handled::Done
        } else {
            Handled::Gone
        }
    }

    /// Handle any event; `Refetch` for everything but a clean status patch.
    fn handle_event(&mut self, ev: &EventFrame) -> Handled {
        if ev.event == "pane.agent_status_changed" {
            self.handle_status(ev)
        } else {
            Handled::Refetch
        }
    }

    /// Take a fresh snapshot, feeding the marks the transitions it shows; `true` when the
    /// pane set changed (resubscribe).
    fn replace(&mut self, fresh: Snapshot) -> bool {
        {
            let mut marks = self.marks.lock();
            marks.retain(&pane_ids(&fresh));
            for p in &fresh.panes {
                let old = self.snap.panes.iter().find(|o| o.pane_id == p.pane_id);
                if let Some(old) = old.filter(|o| o.agent_status != p.agent_status) {
                    marks.on_status(&p.pane_id, old.agent_status, p.agent_status);
                }
            }
        }
        let resubscribe = pane_ids(&fresh) != pane_ids(&self.snap);
        self.snap = fresh;
        resubscribe
    }
}

/// Runs until the stream ends, a call fails, or the receiver is dropped (`None`).
/// `refetch` asks for a fresh snapshot now (e.g. right after a rename or close, ahead of its event).
async fn run(
    name: &str,
    socket: &Path,
    tx: &UnboundedSender<WatchEvent>,
    refetch: &Notify,
    marks: &SharedMarks,
) -> Option<AppError> {
    let snap = match rpc::snapshot(socket).await {
        Ok(s) => s,
        Err(e) => return Some(e),
    };
    let last = {
        let mut m = marks.lock();
        m.retain(&pane_ids(&snap));
        session_view(name, &snap, &m)
    };
    if tx.send(WatchEvent::View(last.clone())).is_err() {
        return None;
    }
    let mut w = Watch {
        name,
        snap,
        last,
        marks,
        tx,
    };
    let mut sub = match subscribe_all(socket, &w.snap).await {
        Ok(s) => s,
        Err(e) => return Some(e),
    };
    let mut need_refetch = false;
    loop {
        // The app's own refetch follows a call herdr already answered: nothing to wait for.
        let mut asked = false;
        if !need_refetch {
            tokio::select! {
                ev = sub.rx.recv() => {
                    let Some(ev) = ev else { return Some(closed()) };
                    match w.handle_event(&ev) {
                        Handled::Done => continue,
                        Handled::Gone => return None,
                        Handled::Refetch => {}
                    }
                }
                _ = marks.changed.notified() => {
                    if !w.send_view() {
                        return None;
                    }
                    continue;
                }
                _ = refetch.notified() => asked = true,
            }
        }
        need_refetch = false;
        // Absorb everything for a fixed window, then refetch once.
        let deadline = Instant::now() + if asked { Duration::ZERO } else { DEBOUNCE };
        loop {
            match timeout_at(deadline, sub.rx.recv()).await {
                Err(_) => break,
                Ok(None) => return Some(closed()),
                Ok(Some(e)) => {
                    if let Handled::Gone = w.handle_event(&e) {
                        return None;
                    }
                }
            }
        }
        let fresh = match rpc::snapshot(socket).await {
            Ok(s) => s,
            Err(e) => return Some(e),
        };
        let resubscribe = w.replace(fresh);
        if !w.send_view() {
            return None;
        }
        if resubscribe {
            // Open the new subscription before dropping the old one, then drain
            // whatever the old one buffered so nothing is lost in the gap.
            let new_sub = match subscribe_all(socket, &w.snap).await {
                Ok(s) => s,
                Err(e) => return Some(e),
            };
            let mut old = std::mem::replace(&mut sub, new_sub);
            while let Ok(ev) = old.rx.try_recv() {
                match w.handle_event(&ev) {
                    Handled::Done => {}
                    Handled::Gone => return None,
                    Handled::Refetch => need_refetch = true,
                }
            }
        }
    }
}

/// Watch one session. Ends after sending `Closed`; the Machine manager owns retries.
pub fn spawn_watcher(
    name: String,
    socket: PathBuf,
    tx: UnboundedSender<WatchEvent>,
    refetch: Arc<Notify>,
    marks: Arc<SharedMarks>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Some(err) = run(&name, &socket, &tx, &refetch, &marks).await {
            let _ = tx.send(WatchEvent::Closed(err));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr::{fake::FakeHerdr, types::AgentStatus};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::{
        sync::mpsc,
        time::{timeout, Duration},
    };

    fn fake_with(snap: Arc<Mutex<Value>>) -> FakeHerdr {
        FakeHerdr::start(Arc::new(move |m, _| match m {
            "session.snapshot" => {
                Ok(json!({"type":"session_snapshot","snapshot": snap.lock().unwrap().clone()}))
            }
            _ => Err(("unknown".into(), m.to_string())),
        }))
    }
    async fn next(rx: &mut mpsc::UnboundedReceiver<WatchEvent>) -> WatchEvent {
        timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn wait_snapshots(f: &FakeHerdr, n: usize) -> bool {
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < end {
            if f.calls_of("session.snapshot") >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }
    /// Nothing arrives for longer than the refetch debounce.
    async fn assert_quiet(rx: &mut mpsc::UnboundedReceiver<WatchEvent>) {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Ok(ev) = rx.try_recv() {
            panic!("unexpected {ev:?}");
        }
    }
    async fn started(
        snap: Arc<Mutex<Value>>,
    ) -> (
        FakeHerdr,
        mpsc::UnboundedReceiver<WatchEvent>,
        tokio::task::JoinHandle<()>,
    ) {
        started_with(snap, Arc::default()).await
    }
    /// A watcher past its first view and subscription.
    async fn started_with(
        snap: Arc<Mutex<Value>>,
        marks: Arc<SharedMarks>,
    ) -> (
        FakeHerdr,
        mpsc::UnboundedReceiver<WatchEvent>,
        tokio::task::JoinHandle<()>,
    ) {
        let f = fake_with(snap);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h = spawn_watcher("default".into(), f.path.clone(), tx, Arc::default(), marks);
        next(&mut rx).await;
        let end = tokio::time::Instant::now() + Duration::from_secs(3);
        while f.calls_of("events.subscribe") < 1 && tokio::time::Instant::now() < end {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (f, rx, h)
    }
    fn fixture_value() -> Arc<Mutex<Value>> {
        Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ))
    }
    fn pane_status(v: &SessionView, pane_id: &str) -> AgentStatus {
        v.workspaces
            .iter()
            .flat_map(|w| &w.tabs)
            .flat_map(|t| &t.panes)
            .find(|p| p.pane_id == pane_id)
            .unwrap()
            .status
    }
    #[tokio::test]
    async fn a_run_ending_in_idle_shows_done_until_the_app_focuses() {
        let marks: Arc<SharedMarks> = Arc::default();
        let (f, mut rx, _h) = started_with(fixture_value(), marks.clone()).await;
        // w1:p1 is working; herdr turns a run ending in its active tab straight to idle.
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p1","agent_status":"idle"}),
        );
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if pane_status(&v, "w1:p1") == AgentStatus::Done)
        );
        assert!(matches!(
            next(&mut rx).await,
            WatchEvent::Status {
                status: AgentStatus::Done,
                previous: AgentStatus::Working,
                ..
            }
        ));
        marks.app_focused("w1:p1");
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if pane_status(&v, "w1:p1") == AgentStatus::Idle)
        );
        assert_quiet(&mut rx).await; // our own seen is no transition
    }
    #[tokio::test]
    async fn herdrs_own_seen_keeps_done_until_the_app_focuses() {
        let marks: Arc<SharedMarks> = Arc::default();
        let (f, mut rx, _h) = started_with(fixture_value(), marks.clone()).await;
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p1","agent_status":"done"}),
        );
        assert!(matches!(next(&mut rx).await, WatchEvent::View(_)));
        assert!(matches!(
            next(&mut rx).await,
            WatchEvent::Status {
                status: AgentStatus::Done,
                ..
            }
        ));
        // Seen in a TUI, or by a pane.focus on a sibling pane of the tab.
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p1","agent_status":"idle"}),
        );
        assert_quiet(&mut rx).await;
        marks.app_focused("w1:p1");
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if pane_status(&v, "w1:p1") == AgentStatus::Idle)
        );
    }
    #[tokio::test]
    async fn herdr_answering_our_own_focus_turns_the_pane_idle() {
        let marks: Arc<SharedMarks> = Arc::default();
        let (f, mut rx, _h) = started_with(fixture_value(), marks.clone()).await;
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p1","agent_status":"done"}),
        );
        assert!(matches!(next(&mut rx).await, WatchEvent::View(_)));
        assert!(matches!(next(&mut rx).await, WatchEvent::Status { .. }));
        marks.app_focused("w1:p1");
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w1:p1","agent_status":"idle"}),
        );
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if pane_status(&v, "w1:p1") == AgentStatus::Idle)
        );
        assert!(matches!(
            next(&mut rx).await,
            WatchEvent::Status {
                status: AgentStatus::Idle,
                previous: AgentStatus::Done,
                ..
            }
        ));
    }
    #[tokio::test]
    async fn a_refetch_showing_a_run_ended_marks_it_done() {
        let snap = fixture_value();
        let (f, mut rx, _h) = started(snap.clone()).await;
        snap.lock().unwrap()["panes"][0]["agent_status"] = json!("idle");
        f.emit("pane.updated", json!({"pane_id":"w1:p1"}));
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if pane_status(&v, "w1:p1") == AgentStatus::Done)
        );
    }
    #[tokio::test]
    async fn malformed_status_event_triggers_refetch() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let (f, mut rx, _h) = started(snap).await;
        f.emit("pane.agent_status_changed", json!({"pane_id": 5}));
        assert!(
            wait_snapshots(&f, 2).await,
            "malformed status should refetch"
        );
        assert_quiet(&mut rx).await; // the refetched snapshot did not change
    }
    #[tokio::test]
    async fn unknown_pane_status_event_triggers_refetch() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let (f, mut rx, _h) = started(snap).await;
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w9:p9","agent_status":"done"}),
        );
        assert!(
            wait_snapshots(&f, 2).await,
            "unknown pane status should refetch"
        );
        assert_quiet(&mut rx).await; // the refetched snapshot did not change
    }
    #[tokio::test]
    async fn emits_view_then_status_changes() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _h = spawn_watcher(
            "default".into(),
            f.path.clone(),
            tx,
            Arc::default(),
            Arc::default(),
        );
        assert!(matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces.len() == 2));
        tokio::time::sleep(Duration::from_millis(100)).await; // let subscribe land
        let subs = f
            .calls
            .lock()
            .unwrap()
            .iter()
            .find(|(m, _)| m == "events.subscribe")
            .unwrap()
            .1
            .clone();
        assert!(subs["subscriptions"]
            .as_array()
            .unwrap()
            .contains(&json!({"type":"pane.agent_status_changed","pane_id":"w2:p1"})));
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w2:p1","workspace_id":"w2","agent_status":"done"}),
        );
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[1].status == AgentStatus::Done)
        );
        match next(&mut rx).await {
            WatchEvent::Status {
                pane_id,
                status,
                previous,
                ..
            } => assert_eq!(
                (pane_id.as_str(), status, previous),
                ("w2:p1", AgentStatus::Done, AgentStatus::Idle)
            ),
            other => panic!("{other:?}"),
        }
    }
    #[tokio::test]
    async fn agent_only_change_sends_a_view_but_no_status() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let (f, mut rx, _h) = started(snap).await;
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w2:p1","agent_status":"idle","agent":"pi"}),
        );
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[1].tabs[0].panes[0].agent.as_deref() == Some("pi"))
        );
        f.emit(
            "pane.agent_status_changed",
            json!({"pane_id":"w2:p1","agent_status":"done","agent":"pi"}),
        );
        assert!(matches!(next(&mut rx).await, WatchEvent::View(_)));
        assert!(matches!(
            next(&mut rx).await,
            WatchEvent::Status {
                status: AgentStatus::Done,
                previous: AgentStatus::Idle,
                ..
            }
        ));
    }
    #[tokio::test]
    async fn structural_events_refetch_once_and_resubscribe() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _h = spawn_watcher(
            "default".into(),
            f.path.clone(),
            tx,
            Arc::default(),
            Arc::default(),
        );
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        snap.lock().unwrap()["panes"].as_array_mut().unwrap().push(json!({"pane_id":"w2:p3","tab_id":"w2:t1","workspace_id":"w2","terminal_id":"term_e","agent_status":"idle"}));
        f.emit("pane_created", json!({"pane_id":"w2:p3"}));
        f.emit("layout_updated", json!({}));
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[1].tabs[0].panes.len() == 2)
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            f.calls_of("session.snapshot"),
            2,
            "two events within 150 ms → one refetch"
        );
        assert_eq!(
            f.calls_of("events.subscribe"),
            2,
            "pane set changed → resubscribe"
        );
    }
    #[tokio::test]
    async fn pane_updated_refetches_the_new_terminal_title() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let (f, mut rx, _h) = started(snap.clone()).await;
        let subs = f
            .calls
            .lock()
            .unwrap()
            .iter()
            .find(|(m, _)| m == "events.subscribe")
            .unwrap()
            .1
            .clone();
        assert!(subs["subscriptions"]
            .as_array()
            .unwrap()
            .contains(&json!({"type":"pane.updated"})));
        snap.lock().unwrap()["panes"][0]["terminal_title_stripped"] = json!("Fix the sidebar");
        // herdr names the frame `pane_updated` and sends the whole pane.
        f.emit(
            "pane_updated",
            json!({"type":"pane_updated","pane":{"pane_id":"w1:p1","terminal_title_stripped":"Fix the sidebar"}}),
        );
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[0].tabs[0].panes[0].title == "Fix the sidebar")
        );
    }
    #[tokio::test]
    async fn refetch_signal_fetches_a_fresh_snapshot() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let refetch: Arc<tokio::sync::Notify> = Arc::default();
        let _h = spawn_watcher(
            "default".into(),
            f.path.clone(),
            tx,
            refetch.clone(),
            Arc::default(),
        );
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        snap.lock().unwrap()["panes"][0]["label"] = json!("renamed");
        refetch.notify_one();
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[0].tabs[0].panes[0].title == "renamed")
        );
        assert_eq!(f.calls_of("session.snapshot"), 2);
    }
    #[tokio::test]
    async fn refetch_signal_skips_the_debounce() {
        let snap = fixture_value();
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let refetch: Arc<tokio::sync::Notify> = Arc::default();
        let _h = spawn_watcher(
            "default".into(),
            f.path.clone(),
            tx,
            refetch.clone(),
            Arc::default(),
        );
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        snap.lock().unwrap()["panes"][0]["label"] = json!("renamed");
        refetch.notify_one();
        let ev = timeout(DEBOUNCE / 2, rx.recv()).await;
        assert!(
            matches!(ev, Ok(Some(WatchEvent::View(v))) if v.workspaces[0].tabs[0].panes[0].title == "renamed"),
            "the app's own refetch is sent before the debounce window ends"
        );
    }
    #[tokio::test]
    async fn refetch_of_an_unchanged_snapshot_sends_nothing() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let f = fake_with(snap.clone());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let refetch: Arc<tokio::sync::Notify> = Arc::default();
        let _h = spawn_watcher(
            "default".into(),
            f.path.clone(),
            tx,
            refetch.clone(),
            Arc::default(),
        );
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        refetch.notify_one();
        assert!(wait_snapshots(&f, 2).await);
        assert_quiet(&mut rx).await;
        // A later change is still sent.
        snap.lock().unwrap()["panes"][0]["label"] = json!("renamed");
        refetch.notify_one();
        assert!(
            matches!(next(&mut rx).await, WatchEvent::View(v) if v.workspaces[0].tabs[0].panes[0].title == "renamed")
        );
    }
    #[tokio::test]
    async fn watcher_reports_closed_when_socket_closes() {
        let snap = Arc::new(Mutex::new(
            serde_json::from_str::<Value>(include_str!("../../tests/fixtures/snapshot.json"))
                .unwrap(),
        ));
        let f = fake_with(snap);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let h = spawn_watcher(
            "default".into(),
            f.path.clone(),
            tx,
            Arc::default(),
            Arc::default(),
        );
        next(&mut rx).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        f.close_subscriptions();
        assert!(matches!(next(&mut rx).await, WatchEvent::Closed(e) if e.code == "io"));
        timeout(Duration::from_secs(1), h).await.unwrap().unwrap();
    }
}
