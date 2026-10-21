//! Herdly's backend without Tauri: Machines and their herdr Sessions, transcripts (Chat),
//! terminal attach, git and files over a Machine's transport. The desktop app and any other
//! front end drive it through `machines::MachineManager`.
pub mod attach;
pub mod complete;
pub mod error;
pub mod files;
pub mod git;
pub mod herdr;
pub mod machines;
pub mod pi;
pub mod quota;
pub mod sshconfig;
pub mod transcript;
pub mod transport;
pub mod view;
