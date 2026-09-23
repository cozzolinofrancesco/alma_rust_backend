# Running the Alma Rust backend in Docker

The backend (`alma-bootstrap`) is a pure HTTP API. TLS is rustls + `ring` with CA
roots bundled into the binary, so the runtime image needs no OpenSSL or system
certs.

## Quick start

```bash
# From rust-api/
docker compose up --build          # build image + run, port 8811 exposed
curl -i http://localhost:8811/      # 404 = server is up (no health route)
```

Or without compose:

```bash
docker build -t alma-rust-api .
docker run --rm -p 8811:8811 -v alma-data:/data alma-rust-api
```

## Modes

- **No `GEMINI_API_KEY`** -> hermetic stub adapters (echo AI / lexical retrieval /
  in-memory store). No external calls, no persistence. Good for smoke tests.
- **`GEMINI_API_KEY` set** -> real Gemini generation + File Search retrieval +
  corpus ingestion, and the file-backed durable store under `/data`.

Pass secrets at runtime, e.g.:

```bash
docker run --rm -p 8811:8811 -v alma-data:/data \
  -e GEMINI_API_KEY=... -e SERVICE_API_KEY=... alma-rust-api
```

With compose, put them in a gitignored `rust-api/.env` (auto-loaded).

## Environment variables

All optional; the defaults run a working stub server. An exported real env var
always wins over `.env`.

- `ALMA_RUST_BIND_ADDRESS` — bind address. Image sets `0.0.0.0:8811`; the code
  default is `127.0.0.1:8811` (loopback), which the image overrides so the port
  is reachable from outside the container.
- `ALMA_RUST_DATA_DIR` — durable store directory. Image sets `/data` (a volume).
- `GEMINI_API_KEY` — enables the real Gemini stack; absent -> stubs.
- `GEMINI_API_URL` — Gemini base URL override (default: the Google Gemini host).
- `GEMINI_DEFAULT_MODEL` — default generation model (default: `gemini-2.5-flash`).
- `GEMINI_AVAILABLE_MODELS` — comma-separated resolvable model ids.
- `GEMINI_FILE_SEARCH_MODEL` — File Search model override.
- `SERVICE_API_KEY` — shared-secret header guard. Set for any exposed deployment.
- `GOOGLE_DRIVE_BASE_URL` — Drive host override (for a local mock).
- `RUST_LOG` — `tracing` EnvFilter directive (default: `info`).

## Data persistence

`/data` holds `document_store.json` (ingested corpora / templates). It is a named
volume (`alma-data`) so it survives `docker compose down`. The file is
intentionally **not** baked into the image — a fresh container starts empty.
