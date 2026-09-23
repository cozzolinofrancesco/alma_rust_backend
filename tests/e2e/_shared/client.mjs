// tests/e2e/_shared/client.mjs
// -----------------------------------------------------------------------------
// Shared test client for the local dual-server end-to-end suite.
//
// "Both servers" = every logical endpoint is exercised twice:
//   • rust:8811   — the Rust API directly           (prefix /api)
//   • proxy:8080  — the Next.js app's rust proxy     (prefix /api/rust → :8811/api)
//
// Auth (see rust-api pipeline/extractor.rs + frontend middleware.ts):
//   • x-api-key       — shared secret (SERVICE_API_KEY). Guards the Rust perimeter
//                       AND satisfies the Next.js middleware without a browser login.
//   • x-account-email — the authorized principal (any valid email locally).
//
// The suite self-loads the repo-root .env.local (walking up, mirroring the Rust
// bootstrap + Next.js) so `node --test tests/e2e/` works with no extra flags.
// Real exported env always wins; secret VALUES are never printed.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function applyEnvFile(file) {
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = assignment.indexOf('=');
    if (eq === -1) continue;
    const key = assignment.slice(0, eq).trim();
    if (!key || key in process.env) continue; // an already-exported var wins
    let value = assignment.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadDotEnvLocal() {
  let dir = HERE;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, '.env.local');
    if (fs.existsSync(candidate)) {
      applyEnvFile(candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

loadDotEnvLocal();

export const SERVICE_API_KEY = process.env.SERVICE_API_KEY;
export const ACCOUNT_EMAIL = process.env.E2E_ACCOUNT_EMAIL || 'e2e@local.test';
// Opt-in: real-Gemini calls cost money and are non-deterministic, so live-AI
// tests are skipped unless this is set.
export const LIVE_AI = process.env.E2E_LIVE_AI === '1' || process.env.E2E_LIVE_AI === 'true';

if (!SERVICE_API_KEY) {
  throw new Error(
    'SERVICE_API_KEY is not set. Add it to the repo-root .env.local (or export it). ' +
      'It authorizes both the Rust perimeter (:8811) and the Next.js proxy (:8080).',
  );
}

export const SERVERS = [
  { name: 'rust:8811', base: process.env.E2E_RUST_URL || 'http://localhost:8811', prefix: '/api' },
  { name: 'proxy:8080', base: process.env.E2E_PROXY_URL || 'http://localhost:8080', prefix: '/api/rust' },
];

export function authHeaders(extra = {}) {
  return { 'x-api-key': SERVICE_API_KEY, 'x-account-email': ACCOUNT_EMAIL, ...extra };
}

/**
 * Call one server. `endpoint` is the logical path WITHOUT the `/api` prefix,
 * e.g. "claim-validation/qc-types" or "v1/agentnodes/runs/plan".
 * Returns { status, json, text, url }.
 */
export async function call(server, method, endpoint, options = {}) {
  const { body, headers, auth = true, timeoutMs = 15000 } = options;
  const url = `${server.base}${server.prefix}/${endpoint}`;
  const requestHeaders = {
    ...(auth ? authHeaders() : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`request to ${method} ${url} failed: ${error.message} (is the server running?)`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — leave json null, keep text */
  }
  return { status: response.status, json, text, url };
}
