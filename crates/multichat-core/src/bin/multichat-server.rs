//! Headless Multi-Chat: the full server without a desktop window.
//! Open the printed URL in a browser or add it to OBS as a browser source.
//!
//!   multichat-server [--virtual] [--port=41414] [--data-dir=<path>]

#[tokio::main]
async fn main() {
    let opts = multichat_core::Options::from_args(std::env::args().skip(1));
    match multichat_core::start(opts).await {
        Ok(_server) => {
            println!("Press Ctrl+C to stop.");
            let _ = tokio::signal::ctrl_c().await;
        }
        Err(e) => {
            eprintln!("{e:#}");
            std::process::exit(1);
        }
    }
}
