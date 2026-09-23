// tests/e2e/ib/ib.test.mjs
// -----------------------------------------------------------------------------
// IB (Investigator's Brochure) money-path — run against BOTH servers.
// IB shares the generic agentnodes pipeline (plan → advance → execute → assemble
// → export). These tests cover the deterministic, no-AI entry points:
//   GET  /api/v1/agentnodes/capabilities  — capability descriptor
//   POST /api/v1/agentnodes/runs/plan     — plan a portable run from a bundle
// (steps/execute + advance are AI-backed and intentionally not run by default.)
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVERS, call } from '../_shared/client.mjs';

// A minimal one-layer bundle: enough for the planner to produce a ready run.
const ibBundle = {
  bundle: {
    schemaVersion: 1,
    agent: {
      name: 'IB Draft',
      layers: [{ id: 'a', name: 'Introduction', userInstruction: 'Draft the IB introduction.', order: 0 }],
      metadata: {},
    },
    sources: [],
    bindings: {},
    sharedSourceIds: [],
    skills: [],
  },
  previousOutputs: {},
};

for (const server of SERVERS) {
  test(`[${server.name}] capabilities descriptor is served`, async () => {
    const r = await call(server, 'GET', 'v1/agentnodes/capabilities');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json?.basePath, '/api/v1/agentnodes');
    assert.equal(typeof r.json?.defaults?.textModel, 'string');
  });

  test(`[${server.name}] runs/plan plans the IB money-path`, async () => {
    const r = await call(server, 'POST', 'v1/agentnodes/runs/plan', { body: ibBundle });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json?.schemaVersion, 1);
    assert.equal(r.json?.checkpoint?.status, 'ready');
    assert.equal(r.json?.nextInputs?.stepId, 'a');
    assert.ok(Array.isArray(r.json?.plan?.order) && r.json.plan.order.includes('a'), 'plan order includes step a');
  });

  test(`[${server.name}] runs/plan rejects a malformed bundle (4xx)`, async () => {
    const r = await call(server, 'POST', 'v1/agentnodes/runs/plan', {
      body: { bundle: { schemaVersion: 1 }, previousOutputs: {} },
    });
    assert.ok(r.status >= 400 && r.status < 500, `expected a 4xx, got ${r.status}: ${r.text}`);
  });

  test(`[${server.name}] runs/plan requires auth (401)`, async () => {
    const r = await call(server, 'POST', 'v1/agentnodes/runs/plan', { auth: false, body: ibBundle });
    assert.equal(r.status, 401, r.text);
  });
}
