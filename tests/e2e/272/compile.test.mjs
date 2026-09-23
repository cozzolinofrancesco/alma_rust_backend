// tests/e2e/272/compile.test.mjs
// -----------------------------------------------------------------------------
// 272 report — run against BOTH servers.
//   POST /api/v1/agentnodes/272/compile  — compile a 272 authoring request into a
//   portable execution bundle { schemaVersion, bundle, requiredSources }.
//   Pure (no AI): studies + templates + sources → validated, bound, snapshotted.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVERS, call } from '../_shared/client.mjs';

// A minimal valid 272 request: one file-backed study bound to one text source,
// resolved against exactly one inline template (templateId matches template.id).
const validCompile = {
  schemaVersion: 1,
  agentName: 'E2E 272 Report',
  studies: [
    {
      id: 's1',
      fileName: 'study-a.pdf',
      docTitle: 'Study A',
      templateId: 'tmpl-1',
      selected: true,
      sourceIds: ['src-1'],
    },
  ],
  templates: { clinical: { id: 'tmpl-1', user_instruction: 'Write the clinical section.' } },
  sources: [{ kind: 'text', sourceId: 'src-1', name: 'Source One', text: 'Reference body text.' }],
};

for (const server of SERVERS) {
  test(`[${server.name}] 272/compile returns a portable bundle`, async () => {
    const r = await call(server, 'POST', 'v1/agentnodes/272/compile', { body: validCompile });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json?.schemaVersion, 1);
    assert.ok(r.json?.bundle && typeof r.json.bundle === 'object', 'bundle present');
    assert.ok(
      Array.isArray(r.json.bundle?.agent?.layers) && r.json.bundle.agent.layers.length >= 1,
      'compiled agent has at least one layer',
    );
    assert.ok(r.json?.requiredSources !== undefined, 'requiredSources present');
  });

  test(`[${server.name}] 272/compile rejects a request with no templates (422)`, async () => {
    const { templates, ...noTemplates } = validCompile;
    void templates;
    const r = await call(server, 'POST', 'v1/agentnodes/272/compile', { body: noTemplates });
    assert.equal(r.status, 422, r.text);
    assert.equal(r.json?.error?.code, 'TEMPLATES_REQUIRED');
  });

  test(`[${server.name}] 272/compile requires auth (401)`, async () => {
    const r = await call(server, 'POST', 'v1/agentnodes/272/compile', { auth: false, body: validCompile });
    assert.equal(r.status, 401, r.text);
  });
}
