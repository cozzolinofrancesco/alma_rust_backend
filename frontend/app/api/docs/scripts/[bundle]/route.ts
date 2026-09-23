import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Self-contained script bundle offered from the docs "Start here" cards.
//
// The bundle is an explicit allowlist of [repoPath, zipPath] pairs — NOT a
// directory dump. This keeps the download to exactly what a user needs to run
// the Alma REST API: repo-internal tooling (tests, audit runners) stays in the
// repo and never ships here. The zip groups sign-in helpers under connect/.
const BUNDLES: Record<string, { label: string; files: [string, string][] }> = {
  api: {
    label: 'alma-api-scripts',
    // python/ + node/ = full REST clients; connect/ = per-language Drive sign-in helpers.
    files: [
      ['scripts/api/python/alma_client.py', 'python/alma_client.py'],
      ['scripts/api/python/run-agent-api.py', 'python/run-agent-api.py'],
      ['scripts/api/python/alma_connect.py', 'python/alma_connect.py'],
      ['scripts/api/python/requirements.txt', 'python/requirements.txt'],
      ['scripts/api/python/examples/agent-api-272.json', 'python/examples/agent-api-272.json'],
      ['scripts/api/node/run-agent-api.mjs', 'node/run-agent-api.mjs'],
      ['scripts/api/node/alma-connect.mjs', 'node/alma-connect.mjs'],
      ['scripts/api/r/alma_connect.R', 'connect/alma_connect.R'],
      ['scripts/api/sh/alma-connect.sh', 'connect/alma-connect.sh'],
      ['scripts/api/ps1/alma-connect.ps1', 'connect/alma-connect.ps1'],
    ],
  },
};

function envFile(): string {
  // Point the bundle at the browser sign-in it actually uses: the REST clients
  // read a ~1h Google token file.
  const googleHint = [
    '# Optional — only for Google Drive / Sheets / corpus features.',
    '# Easiest: run `python3 python/alma_connect.py` (or node/alma-connect.mjs) to sign in, then set:',
    '# GOOGLE_ACCESS_TOKEN_FILE=~/.alma/google-access-token   (renew with --refresh)',
    '# Or set GOOGLE_ACCESS_TOKEN= , or use ALMA_GOOGLE_ADC=1 (gcloud ADC).',
  ];
  return [
    '# Alma configuration. Your AI assistant can ask you for the key and fill it in here.',
    'ALMA_API_URL=https://frontendv3-1097734190017.europe-west4.run.app/api/v1/agentnodes',
    'ALMA_API_KEY=',
    '',
    ...googleHint,
    '',
  ].join('\n');
}

function startReadme(): string {
  return [
    '# Alma API — quick start',
    '',
    '1. Set `ALMA_API_URL=<origin>/api/v1/agentnodes` and `ALMA_API_KEY=<key>` (see alma.env).',
    '2. For Drive / corpus / Sheets, sign in to Google once (writes a token file the clients read):',
    '     python3 python/alma_connect.py        # or: node node/alma-connect.mjs',
    '     # R / shell / PowerShell sign-in: connect/alma_connect.R, connect/alma-connect.sh, connect/alma-connect.ps1',
    '     export GOOGLE_ACCESS_TOKEN_FILE="$HOME/.alma/google-access-token"   # renew later: --refresh',
    '   (Advanced: gcloud ADC. Inline-source 272s need no Google token.)',
    '3. Python: `python3 python/run-agent-api.py <bundle.json> <checkpoint.json> --output results`',
    '   Node:   `node node/run-agent-api.mjs <bundle.json> <checkpoint.json> --output results`',
    '4. Example 272 payload: `python/examples/agent-api-272.json` (inline sources — no Google token needed).',
    '',
    'Full docs: /docs/workflows',
    '',
  ].join('\n');
}

export async function GET(_request: Request, { params }: { params: Promise<{ bundle: string }> }) {
  const { bundle } = await params;
  const spec = BUNDLES[bundle];
  if (!spec) {
    return NextResponse.json({ error: 'Unknown bundle. Use "api".' }, { status: 404 });
  }

  const cwd = process.cwd();
  const zip = new JSZip();
  let added = 0;
  for (const [src, dest] of spec.files) {
    try {
      zip.file(dest, await readFile(path.join(cwd, src)));
      added++;
    } catch {
      // file missing in this deployment — skip it rather than failing the whole download
    }
  }

  if (added === 0) {
    return NextResponse.json({ error: 'Scripts are not available in this deployment.' }, { status: 404 });
  }

  zip.file('alma.env', envFile());
  zip.file('START.md', startReadme());

  const body = await zip.generateAsync({ type: 'nodebuffer' });
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${spec.label}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
