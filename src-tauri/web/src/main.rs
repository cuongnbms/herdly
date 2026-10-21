use clap::Parser;
use herdly_web::cli::{run, Cli};

fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    if let Err(msg) = run(Cli::parse()) {
        eprintln!("herdly-web: {msg}");
        std::process::exit(1);
    }
}
