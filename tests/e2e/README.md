# Local dual-server E2E tests

End-to-end test cases for **ib**, **272**, and **qc**, each exercised against **both servers**:

| Target | URL | Path prefix | Notes |
|---|---|---|---|
| `rust:8811` | `http://localhost:8811` | `/api` | Rust API directly |
| `proxy:8080` | `http://localhost:8080` | `/api/rust` | Next.js proxy → forwards to `:8811/api/*` |

One folder, divided by type:

```
tests/e2e/
├── _shared/client.mjs   # env loader + auth headers + request helper + SERVERS
├── ib/ib.test.mjs       # capabilities + runs/plan (IB money-path)
├── 272/compile.test.mjs # 272/compile → portable bundle
├── qc/qc.test.mjs       # qc-types + validate
└── README.md
```

## Prerequisites

1. **Both servers running** (from the repo root):
   ```sh
   # Rust API — auto-loads repo-root .env.local (walks up), binds 127.0.0.1:8811
   (cd rust-api && cargo run -p alma-bootstrap)

   # Frontend — reads frontend/.env.local (symlinked to repo-root .env.local), port 8080
   (cd frontend && ALMA_RUST_API_URL=http://localhost:8811 npm run dev)
   ```
2. **`.env.local` at the repo root** with `SERVICE_API_KEY` (already present). It authorizes
   both the Rust shared-secret perimeter and the Next.js middleware, so tests run headless
   (no browser login). The suite loads it automatically — the value never needs to be typed.

## Run

```sh
# from the repo root — all types, both servers (quote the glob; Node expands it)
node --test 'tests/e2e/**/*.test.mjs'

# a single type
node --test 'tests/e2e/qc/*.test.mjs'
node --test 'tests/e2e/272/*.test.mjs'
node --test 'tests/e2e/ib/*.test.mjs'
```

> Note: this Node build does not scan bare directories (`node --test tests/e2e/`),
> so pass the quoted glob (or explicit file paths) as shown.

## Auth model (why the headers)

Every request sends two headers (built in `_shared/client.mjs`):

- `x-api-key: $SERVICE_API_KEY` — the shared secret. Guards the Rust perimeter
  (`rust-api` `pipeline/extractor.rs`) **and** satisfies the Next.js middleware
  (`frontend/middleware.ts`) without a NextAuth session.
- `x-account-email: e2e@local.test` — the authorized principal (any valid email works locally).

The `*requires auth (401)` cases send **no** headers and assert a 401 from each server
(the Rust structured error vs. the middleware's `{"error":"Unauthorized"}`).

## Config (env overrides)

| Var | Default | Purpose |
|---|---|---|
| `SERVICE_API_KEY` | from `.env.local` | shared-secret auth (required) |
| `E2E_ACCOUNT_EMAIL` | `e2e@local.test` | `x-account-email` principal |
| `E2E_RUST_URL` | `http://localhost:8811` | direct target base |
| `E2E_PROXY_URL` | `http://localhost:8080` | proxy target base |
| `E2E_LIVE_AI` | _(unset)_ | set `1` to run the live-Gemini `validate` test |

## Note on AI-backed paths

When `GEMINI_API_KEY` is present the Rust server runs in **real Gemini mode**, so
AI-backed endpoints (`claim-validation/validate`, agentnodes `steps/execute` / `advance`)
make real, billable, non-deterministic calls. The default suite only asserts
deterministic, no-AI paths (`qc-types`, `272/compile`, `runs/plan`, `capabilities`) plus
input-validation and auth negatives. The one live-AI test is skipped unless `E2E_LIVE_AI=1`.
