import type { drive_v3 } from 'googleapis';
import { ensureAfFolder, listAfJsonFiles } from './afFolder';
import { readJsonFileById } from './jsonFile';
import type { AgentnodesMetaV1 } from './metaSidecar';

const META_SUFFIX = '.agentnodes-meta.json';

async function forEachMetaFile(
  drive: drive_v3.Drive,
  projectId: string,
  visit: (meta: AgentnodesMetaV1, fileId: string) => Promise<boolean | void>
): Promise<void> {
  const af = await ensureAfFolder(drive, projectId);
  const files = await listAfJsonFiles(drive, af);
  for (const f of files) {
    if (!f.name?.endsWith(META_SUFFIX) || !f.id) continue;
    const parsed = await readJsonFileById<AgentnodesMetaV1>(drive, f.id);
    if (!parsed || parsed.version !== 1) continue;
    const stop = await visit(parsed, f.id);
    if (stop === true) return;
  }
}

export async function findRunInProjectMetas(
  drive: drive_v3.Drive,
  projectId: string,
  runId: string
): Promise<{ meta: AgentnodesMetaV1; fileId: string; run: AgentnodesMetaV1['runs'][number] } | null> {
  let found: { meta: AgentnodesMetaV1; fileId: string; run: AgentnodesMetaV1['runs'][number] } | null = null;
  await forEachMetaFile(drive, projectId, async (meta, fileId) => {
    const run = meta.runs.find((r) => r.id === runId);
    if (run) {
      found = { meta, fileId, run };
      return true;
    }
  });
  return found;
}

export async function findSimulationInProjectMetas(
  drive: drive_v3.Drive,
  projectId: string,
  simulationId: string
): Promise<{ meta: AgentnodesMetaV1; fileId: string; sim: AgentnodesMetaV1['simulations'][number] } | null> {
  let found: { meta: AgentnodesMetaV1; fileId: string; sim: AgentnodesMetaV1['simulations'][number] } | null = null;
  await forEachMetaFile(drive, projectId, async (meta, fileId) => {
    const sim = meta.simulations.find((s) => s.id === simulationId);
    if (sim) {
      found = { meta, fileId, sim };
      return true;
    }
  });
  return found;
}
