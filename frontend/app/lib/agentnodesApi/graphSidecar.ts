import type { drive_v3 } from 'googleapis';
import type { AgentNodesGraphV1 } from '../../agentnodes/lib/types';
import { findFileIdByName, readJsonFileById, writeJsonNamedFile, deleteFileById } from './jsonFile';
import { ensureAfFolder } from './afFolder';

export function graphSidecarFileName(agentId: string): string {
  return `${agentId}.agentnodes-graph.json`;
}

export async function readGraphSidecar(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string
): Promise<{ graph: AgentNodesGraphV1; fileId: string } | null> {
  const af = await ensureAfFolder(drive, projectId);
  const fileId = await findFileIdByName(drive, af, graphSidecarFileName(agentId));
  if (!fileId) return null;
  const graph = await readJsonFileById<AgentNodesGraphV1>(drive, fileId);
  if (!graph || graph.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return null;
  }
  return { graph, fileId };
}

export async function writeGraphSidecar(
  drive: drive_v3.Drive,
  projectId: string,
  graph: AgentNodesGraphV1
): Promise<{ fileId: string }> {
  const af = await ensureAfFolder(drive, projectId);
  const name = graphSidecarFileName(graph.agentId);
  const { fileId } = await writeJsonNamedFile(drive, af, name, graph);
  return { fileId };
}

export async function deleteGraphSidecar(
  drive: drive_v3.Drive,
  projectId: string,
  agentId: string
): Promise<boolean> {
  const af = await ensureAfFolder(drive, projectId);
  const fileId = await findFileIdByName(drive, af, graphSidecarFileName(agentId));
  if (!fileId) return false;
  await deleteFileById(drive, fileId);
  return true;
}
