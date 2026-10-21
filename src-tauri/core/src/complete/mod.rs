//! Completion candidates for the Chat lens composer, read on the Pane's Machine.
pub mod commands;
pub mod dirs;
pub mod entries;
pub mod files;
pub use commands::{list_commands, SlashCommand};
pub use dirs::list_dirs;
pub use entries::list_entries;
pub use files::list_files;
