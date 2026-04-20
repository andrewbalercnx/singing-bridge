// File: server/build.rs
// Purpose: Capture the short git SHA at compile time and expose it as
//          the GIT_SHA env var consumed by health.rs for /healthz.
//          Priority: GIT_SHA env var (set via Docker --build-arg in CI)
//          → git rev-parse (local dev) → "unknown".
// Last updated: Sprint 9 (2026-04-20) -- fall back to GIT_SHA build arg

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");

    // In Docker builds .git is absent; the SHA is injected via --build-arg.
    let sha = std::env::var("GIT_SHA")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--short", "HEAD"])
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=GIT_SHA={sha}");
}
