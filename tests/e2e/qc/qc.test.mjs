// tests/e2e/qc/qc.test.mjs
// -----------------------------------------------------------------------------
// QC (quality control / claim validation) — run against BOTH servers.
//   GET  /api/claim-validation/qc-types   — the QC catalog (deterministic, no AI)
//   POST /api/claim-validation/validate   — claim validation (AI-backed)
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVERS, call, LIVE_AI } from '../_shared/client.mjs';

for (const server of SERVERS) {
  test(`[${server.name}] GET qc-types returns the QC catalog`, async () => {
    const r = await call(server, 'GET', 'claim-validation/qc-types');
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json?.qcTypes), 'response must carry a qcTypes array');
    assert.ok(r.json.qcTypes.length >= 1, 'expected at least one QC type');
  });

  test(`[${server.name}] POST validate rejects empty text (400)`, async () => {
    const r = await call(server, 'POST', 'claim-validation/validate', {
      body: { text: '', source: { sourceId: 'src-1', document: 'reference document' } },
    });
    assert.equal(r.status, 400, r.text);
    // Direct returns the structured Rust error; the proxy relays the same body.
    assert.equal(r.json?.error_category, 'request_body_was_malformed');
  });

  test(`[${server.name}] qc-types requires auth (401)`, async () => {
    const r = await call(server, 'GET', 'claim-validation/qc-types', { auth: false });
    assert.equal(r.status, 401, r.text);
  });

  // Real Gemini call — opt in with E2E_LIVE_AI=1 (costs money, non-deterministic).
  test(
    `[${server.name}] POST validate runs claim validation (live AI)`,
    { skip: LIVE_AI ? false : 'set E2E_LIVE_AI=1 to run (issues a real Gemini call)' },
    async () => {
      const r = await call(server, 'POST', 'claim-validation/validate', {
        timeoutMs: 60000,
        body: {
          text: 'The drug reduced systolic blood pressure by 20% in every patient.',
          source: {
            sourceId: 'src-1',
            document: 'In the trial, mean systolic blood pressure decreased by 12% over 8 weeks.',
          },
        },
      });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json && typeof r.json === 'object', 'expected a JSON validation result');
    },
  );
}
