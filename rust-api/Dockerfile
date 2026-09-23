# syntax=docker/dockerfile:1
#
# Multi-stage build for the Alma Rust backend (bin: alma-bootstrap).
#
# TLS is rustls + `ring` (no OpenSSL / native-tls), and the CA roots are bundled
# into the binary via webpki-roots, so the runtime image needs no system crypto
# libraries. `ring` needs perl + a C compiler at build time — both ship in the
# official `rust` (buildpack-deps) image, so no extra build packages are needed.

########################
# Stage 1 — builder
########################
FROM rust:1.95-bookworm AS builder

WORKDIR /app

# Copy the whole workspace. .dockerignore keeps target/, data/, docs, and env
# files out of the build context so this stays small and reproducible.
COPY . .

# Release build. BuildKit cache mounts keep the cargo registry and the target
# dir warm across rebuilds; the binary is copied OUT of the cached target dir in
# the same layer because cache mounts are not persisted into the image.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked --bin alma-bootstrap \
 && cp /app/target/release/alma-bootstrap /app/alma-bootstrap

########################
# Stage 2 — runtime
########################
FROM debian:bookworm-slim AS runtime

# ca-certificates: defensive only (rustls uses bundled webpki-roots).
# curl: used solely by the HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user.
RUN useradd --system --create-home --uid 10001 app

COPY --from=builder /app/alma-bootstrap /usr/local/bin/alma-bootstrap

# Durable document store lives here (written only when GEMINI_API_KEY is set).
# Declared a volume so ingested corpora persist across container restarts.
RUN mkdir -p /data && chown app:app /data
VOLUME ["/data"]

# Container-critical: the app defaults to 127.0.0.1 (loopback only), which is
# unreachable from outside the container — bind to 0.0.0.0 here.
ENV ALMA_RUST_BIND_ADDRESS=0.0.0.0:8811 \
    ALMA_RUST_DATA_DIR=/data \
    RUST_LOG=info

EXPOSE 8811
USER app

# No dedicated health route exists; a 404 on "/" still proves the server is
# accepting connections. curl without -f exits 0 on any HTTP response, and
# non-zero on connection refused.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -s -o /dev/null http://localhost:8811/ || exit 1

ENTRYPOINT ["alma-bootstrap"]
