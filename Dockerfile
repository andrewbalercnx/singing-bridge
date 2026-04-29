# File: Dockerfile
# Purpose: Two-stage build — Rust release binary in distroless cc image.
# Role: Production container image for Azure Container Apps.
# Invariants: Final image runs as non-root (UID 65532). SB_STATIC_DIR=/app/web.
#             Migrations are bundled at /app/migrations.
#             Build stage pulls from sbprodacr (ACR) to avoid Docker Hub rate limits.
# Last updated: Sprint 26 (2026-04-29) -- use ACR-cached debian+rustup to avoid Docker Hub rate limit

# stage 1: build — debian:bookworm-slim from ACR mirror; rustup installs the pinned toolchain
FROM sbprodacr.azurecr.io/debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gcc libc6-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
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
