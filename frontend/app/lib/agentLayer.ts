import type { Layer } from '../ai-agents/edit/[agent-id]/AgentEditorContext';
import { DEFAULT_MODEL } from './modelConfig';

/**
 * Single source of truth for a brand-new step's default shape. Used by BOTH the
 * form/embedded editor (AgentEditorContext.addLayer) and the standalone graph
 * data layer (useAgentNodesData.addLayer) so a step created in either view
 * serializes with the same ~25 fields instead of a thin 5-field stub.
 */
export function createDefaultLayer(id: string, name: string, order: number): Layer {
  return {
    id,
    name,
    type: 'user',
    isActive: true,
    order,
    pod: '',
    systemInstruction: '',
    userInstruction: '',
    assistantResponse: '',
    functionCall: '',
    toolCall: '',
    selectedModel: DEFAULT_MODEL,
    referencedSteps: [],
    userInput: '',
    result: '',
    imageUrls: [],
    urlContent: [],
    condition: '',
    isFrozen: false,
    keepMaster: false,
    outputType: 'basic',
    image: null,
    inputUrl: '',
    inputUrlType: '',
    bibliography: [],
    ragKnowledge: [],
  };
}

export const MAX_AGENT_NAME_LENGTH = 100 as const;

/**
 * Sanitize a user-supplied agent name before it becomes part of a Drive
 * filename (`<name>_<iso>_<hash>.json`). Drops control characters, turns path
 * separators into spaces, collapses whitespace, and trims. Returns '' if
 * nothing usable remains (callers should reject empty).
 */
export function sanitizeAgentName(raw: string): string {
  const withoutControl = Array.from(raw ?? '')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  return withoutControl
    .replace(/[/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DefaultAgent {
  version: string;
  name: string;
  layers: Layer[];
  metadata: {
    created: string;
    modified: string;
    description: string;
    notes: Array<{ username: string; text: string; timestamp: string }>;
  };
}

/**
 * Single source of truth for a brand-new agent. Replaces the per-call-site
 * inline literals (form page, Navbar voice, canvas panel) so every create path
 * produces the same shape and reuses createDefaultLayer for the first step.
 */
export function createDefaultAgent(name: string, description = ''): DefaultAgent {
  const timestamp = new Date().toISOString();
  return {
    version: '1.0.0',
    name,
    layers: [createDefaultLayer('layer-1', 'Step 1', 0)],
    metadata: { created: timestamp, modified: timestamp, description, notes: [] },
  };
}
