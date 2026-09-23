import type { Canvas272Layer } from '../../canvas-272/lib/types';
import { mergeAgentSameVersion, type AgentData, type VersionedAgentData } from '../versionUtils';

export type AgentPatchInput = {
  name: string;
  layers: Canvas272Layer[];
  metadata?: AgentData['metadata'];
};

export async function mergeSameVersionAgentPayload(existingData: unknown, agent: AgentPatchInput): Promise<unknown> {
  return mergeAgentSameVersion(existingData as VersionedAgentData | AgentData, agent as AgentData);
}
