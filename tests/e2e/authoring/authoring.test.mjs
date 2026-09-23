// tests/e2e/authoring/authoring.test.mjs
// -----------------------------------------------------------------------------
// Authoring (canvas-272) — the compute endpoints ported to Rust. Run against
// BOTH servers: rust:8811 (direct) and proxy:8080 (Next.js /api/rust proxy,
// dual-mode auth). Covers:
//   POST /export/docx                       — StructuredDoc → binary .docx
//   GET/PUT /canvas-272/sidecar/{id}        — per-agent sidecar round-trip
//   POST /gemini                            — messages[] path (canvas step editor)
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVERS, call, authHeaders, LIVE_AI } from '../_shared/client.mjs';

const STRUCTURED_DOC = {
  doc: {
    title: 'E2E Authoring Report',
    agentName: 'Agent A',
    exportedAt: '2026-01-01T00:00:00.000Z',
    sections: [
      { heading: 'Introduction', tag: null, steps: [{ number: '1', name: 'Intro', output: 'Hello world' }] },
    ],
  },
  fileName: 'e2e-authoring',
};

for (const server of SERVERS) {
  test(`[${server.name}] export/docx returns a .docx package`, async () => {
    // Binary response — use fetch directly (the shared client is text-based).
    const response = await fetch(`${server.base}${server.prefix}/export/docx`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(STRUCTURED_DOC),
    });
    // Read the body exactly once (it may be binary), then assert against it.
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, bytes.toString('utf8').slice(0, 200));
    assert.match(
      response.headers.get('content-type') || '',
      /wordprocessingml\.document/,
      'docx content-type',
    );
    assert.ok(bytes.length > 4, 'non-empty body');
    assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304', 'ZIP (PK) signature');
  });

  test(`[${server.name}] export/docx requires auth (401)`, async () => {
    const r = await call(server, 'POST', 'export/docx', { auth: false, body: STRUCTURED_DOC });
    assert.equal(r.status, 401, r.text);
  });

  test(`[${server.name}] sidecar PUT then GET round-trips`, async () => {
    const projectId = 'e2e-proj';
    const agentId = `e2e-agent-${Math.random().toString(36).slice(2, 8)}`;
    const sidecar = { version: 1, agentId, agentName: 'Agent A', updatedAt: 't', outputs: { s1: 'edited' } };

    const put = await call(server, 'PUT', `canvas-272/sidecar/${agentId}?projectId=${projectId}`, {
      body: { sidecar },
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json?.ok, true);

    const get = await call(server, 'GET', `canvas-272/sidecar/${agentId}?projectId=${projectId}`);
    assert.equal(get.status, 200, get.text);
    assert.equal(get.json?.sidecar?.outputs?.s1, 'edited');
  });

  test(`[${server.name}] sidecar GET is 404 when absent`, async () => {
    const r = await call(server, 'GET', `canvas-272/sidecar/missing-${Date.now()}?projectId=none`);
    assert.equal(r.status, 404, r.text);
  });

  test(`[${server.name}] gemini rejects a body with neither prompt nor messages (400)`, async () => {
    const r = await call(server, 'POST', 'gemini', { body: { model: 'gemini-2.5-flash' } });
    assert.equal(r.status, 400, r.text);
  });

  // Real Gemini call — opt in with E2E_LIVE_AI=1 (costs money, non-deterministic).
  test(
    `[${server.name}] gemini accepts the messages[] path (live AI)`,
    { skip: LIVE_AI ? false : 'set E2E_LIVE_AI=1 to run (issues a real Gemini call)' },
    async () => {
      const r = await call(server, 'POST', 'gemini', {
        timeoutMs: 60000,
        body: { messages: [{ role: 'user', text: 'Reply with the single word: pong' }], model: 'gemini-2.5-flash' },
      });
      assert.equal(r.status, 200, r.text);
      assert.equal(typeof r.json?.response, 'string');
    },
  );
}
