pub mod background;
pub mod codec;
#[cfg(test)]
pub mod fake;
pub mod model;
pub mod rpc;
pub mod types;
pub mod watcher;

/// The herdr wire protocol version this app speaks. Anything else is `incompatible`.
pub const REQUIRED_PROTOCOL: u32 = 22;
