#[path = "../pinned_tls_proof/mod.rs"]
mod pinned_tls_proof;

#[tokio::main]
async fn main() {
    if let Err(error) = pinned_tls_proof::run_from_args(std::env::args().skip(1)).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
