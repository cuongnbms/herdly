//! The Terminal lens: owned Attach handles, local target resolution, the socket's wire
//! protocol, its bounded output queue, the attempt registry and the `/ws/terminal` socket.
pub mod backend;
pub mod protocol;
pub mod queue;
pub mod registry;
pub mod socket;
