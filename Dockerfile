# File: Dockerfile
# Purpose: Two-stage build — Rust release binary in distroless cc image.
# Role: Production container image for Azure Container Apps.
# Invariants: Final image runs as non-root (UID 65532). SB_STATIC_DIR=/app/web.
#             Migrations are bundled at /app/migrations.
# Last updated: Sprint 20 (2026-04-25) -- ARG GIT_SHA in stage 2 to bust ACR layer cache for web assets

# stage 1: build
FROM docker.io/library/rust:1.82-bookworm AS build
WORKDIR /src

# Cache dependency build separately from application code.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY server/Cargo.toml server/Cargo.toml
RUN mkdir -p server/src && echo 'fn main(){}' > server/src/main.rs \
 && cargo build --release -p singing-bridge-server 2>/dev/null || true
COPY server ./server
ARG GIT_SHA=unknown
RUN GIT_SHA=${GIT_SHA} cargo build --release -p singing-bridge-server

# stage 2: minimal runtime (glibc via cc variant)
FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/target/release/singing-bridge-server /app/server
# ARG here busts the ACR layer cache for web assets on every build.
ARG WEB_CACHE_BUST=0
COPY web /app/web
COPY server/migrations /app/migrations

WORKDIR /app
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/server"]
