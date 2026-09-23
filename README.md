# Alma

Alma is a clinical/scientific **report-authoring platform** for pharma & regulatory writing — it
drafts CTD 2.7.2 reports with AI agents, runs RAG over a knowledge corpus, validates claims, and
exports finished documents. This repository holds the **Rust (axum) API** and the **Next.js frontend**.

## What's in the repo

```
alma_rust_backend/
├── rust-api/     # Rust (axum) API backend — Cargo workspace
│                 #   (hexagonal: domain / application / infrastructure / http / macros / bootstrap)
├── frontend/     # Next.js 15 app (the UI)
├── templates/    # study-type definitions
├── tests/e2e/    # cross-server end-to-end tests
└── docs/         # design rationale + full API reference
```

## Prerequisites

- Rust 1.95+ (edition 2024) and cargo
- Node.js 20+ and npm

## Run it locally

Two servers. First put shared config in `.env.local` at the repo root and symlink it for the frontend:

```bash
# .env.local (repo root)
SERVICE_API_KEY=any-local-secret
NEXTAUTH_SECRET=any-local-secret
# optional: GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

ln -sf ../.env.local frontend/.env.local
```

Start the backend (→ http://127.0.0.1:8811):

```bash
cd rust-api && cargo run -p alma-bootstrap
```

Start the frontend (→ http://localhost:8080):

```bash
cd frontend && npm install
ALMA_RUST_API_URL=http://localhost:8811 npm run dev
```

Open **http://localhost:8080**. Without a `GEMINI_API_KEY` the backend runs deterministic offline
stubs, so the whole stack works with no external credentials.

## Testing

```bash
cd rust-api && cargo test                # Rust unit/integration tests
cd frontend && npm test                  # frontend tests
node --test 'tests/e2e/**/*.test.mjs'    # cross-server e2e (needs both servers running)
```

## Docker

```bash
cd rust-api && docker compose up --build # backend on :8811 (see rust-api/DOCKER.md)
```

## Docs & license

- Architecture rationale + full API reference: [docs/RATIONALE_AND_API_REFERENCE.md](docs/RATIONALE_AND_API_REFERENCE.md)
- Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).
