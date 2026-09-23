
import type { Canvas272Agent } from '../../canvas-272/lib/types';

let debugAgent: Canvas272Agent | null = null;

export function setAgentnodesDebugAgent(agent: Canvas272Agent | null): void {
  debugAgent = agent;
}

export function clearAgentnodesDebugAgent(): void {
  debugAgent = null;
}

export function getAgentnodesDebugAgent(): Canvas272Agent | null {
  return debugAgent;
}

export function stringifyAgentnodesDebugAgentForDisplay(): string {
  if (!debugAgent) return '';
  try {
    return JSON.stringify(debugAgent, null, 2);
  } catch {
    return '{"error":"JSON.stringify failed"}';
  }
}
