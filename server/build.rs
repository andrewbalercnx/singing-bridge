// File: server/build.rs
// Purpose: Capture the short git SHA at compile time and expose it as
//          the GIT_SHA env var consumed by health.rs for /healthz.
// Last updated: Sprint 9 (2026-04-20) -- initial

use std::process::Command;

fn main() {
    // Re-run if HEAD changes (new commit or checkout).
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");

    let sha = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=GIT_SHA={sha}");
}
