import type { StepModelOption } from '../stepModels';

export const GALILEO_REFERENCE_SOURCE = 'User-supplied Galileo directory, 2026-09-09';

const openaiReferences = [
  ['gpt-5.6-luna', 'GPT-5.6 Luna'],
  ['gpt-5.6-sol', 'GPT-5.6 Sol'],
  ['gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['gpt-5.5-2026-04-23', 'GPT-5.5'],
  ['gpt-5.5-pro-2026-04-23', 'GPT-5.5 pro'],
  ['gpt-5.4-mini-2026-03-17', 'GPT-5.4 mini'],
  ['gpt-5.4-nano-2026-03-17', 'GPT-5.4 nano'],
  ['gpt-5.4-2026-03-05', 'GPT-5.4'],
  ['gpt-5.3-codex', 'GPT-5.3 codex'],
  ['gpt-5.2-2025-12-11', 'GPT-5.2'],
  ['gpt-5.1-2025-11-13', 'GPT-5.1'],
  ['gpt-5-2025-08-07', 'GPT-5'],
  ['gpt-5-mini-2025-08-07', 'GPT-5 mini'],
  ['gpt-5-nano-2025-08-07', 'GPT-5 nano'],
  ['o3-2025-04-16', 'o3'],
  ['gpt-4.1-2025-04-14', 'GPT-4.1'],
  ['gpt-4.1-mini-2025-04-14', 'GPT-4.1 mini'],
  ['gpt-4o-2024-11-20', 'GPT-4o'],
  ['gpt-4o-mini-2024-07-18', 'GPT-4o mini'],
] as const;

export const GALILEO_REFERENCE_MODELS: StepModelOption[] = [
  ...openaiReferences.map(([modelId, name]) => ({
    value: `galileo:openai:${modelId}`,
    label: `${name} (Galileo / OpenAI)`,
    description: GALILEO_REFERENCE_SOURCE,
    capabilities: [],
    disabled: true,
  })),
  {
    value: 'galileo:bedrock:anthropic.claude-3-haiku-20240307-v1:0',
    label: 'Claude Haiku 3 (Galileo / Amazon Bedrock)',
    description: GALILEO_REFERENCE_SOURCE,
    capabilities: [],
    disabled: true,
  },
];