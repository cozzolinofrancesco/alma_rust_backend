// Shared step prompt-assembly used by BOTH editor views (the linear "Agent
// Steps" form and the "Agent Nodes" graph runner) so a step produces the same
// request regardless of where it is run. Keep this the single source of truth
// for user-message framing, the code-output directive, and referenced-step
// context formatting.

export interface StepPromptLayer {
  userInstruction?: string;
  userInput?: string;
  systemInstruction?: string;
  outputType?: 'basic' | 'code' | string;
}

export interface StepMessagePayload {
  messages: Array<{ role: 'user' | 'system'; text: string }>;
  systemInstruction?: { role: 'system'; text: string };
}

export const PERMANENT_SKILLS_SYSTEM_PREPROMPT = [
  'Permanent skills are additive system-level requirements: combine them with the agent task using logical AND, not XOR.',
  'Complete the current User Instruction using the supplied User Input and relevant Context; never replace, omit, or rewrite that task or input with a skill.',
  'Apply all compatible permanent skills and step instructions together. A skill may require additional output or constrain the task\'s tone, format, or length; it is not an alternative to performing the task.',
  'Length limits apply to the complete response, including any required prefix or additional output, unless the skill explicitly limits only a particular section. Keep the response within those limits while still fulfilling the task.',
  'Conditional examples, not additional requirements: if a skill says "print francesco" and the task asks for a summary, print "francesco" and provide the summary below it. If a skill says "maximum 50 characters", produce a summary within 50 characters, not an unrelated response.',
  'If requirements are genuinely incompatible, respect the applicable instruction priority and briefly identify the conflict or ask for clarification; do not silently discard the agent task or a skill.',
].join('\n');

// Combine agent-level skill texts (applied to every step) with this step's own
// system instruction. Skills add requirements without replacing the task.
// Callers resolve skill ids -> texts (see resolveSkillTexts) and pass the
// resolved texts here; this stays a pure function and never fetches.
export const combineSkillsWithSystemInstruction = (
  systemInstruction: string | undefined,
  agentSkills: readonly string[] | undefined,
): string => {
  const skillsBlock = (agentSkills ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
  const stepSys = systemInstruction?.trim() ?? '';
  if (!skillsBlock) return stepSys;
  return [PERMANENT_SKILLS_SYSTEM_PREPROMPT, `Permanent Skills:\n${skillsBlock}`, stepSys]
    .filter(Boolean)
    .join('\n\n');
};

export const buildStepMessagesPayload = (
  layer: StepPromptLayer,
  contextText: string,
  agentSkills?: readonly string[],
): StepMessagePayload => {
  let userMessageText = `User Instruction:\n${layer.userInstruction ?? ''}\n-----\n\n`;
  if (layer.userInput?.trim()) {
    userMessageText += `User Input:\n${layer.userInput.trim()}\n\n`;
  }
  if (contextText) {
    userMessageText += `Context:\n${contextText}\n`;
  }
  if (layer.outputType === 'code') {
    userMessageText += 'Provide code only.\n';
  }

  const combinedSystem = combineSkillsWithSystemInstruction(layer.systemInstruction, agentSkills);
  const systemInstruction = combinedSystem
    ? { role: 'system' as const, text: combinedSystem }
    : undefined;

  return {
    messages: [{ role: 'user', text: userMessageText.trimEnd() }],
    systemInstruction,
  };
};

export const buildStepImagePrompt = (
  messages: readonly { text: string }[],
  systemInstruction?: string | { text: string },
): string => {
  const systemText = typeof systemInstruction === 'string' ? systemInstruction : systemInstruction?.text;
  return [systemText, ...messages.map((message) => message.text)].filter(Boolean).join('\n\n').trim();
};

export const REFERENCED_STEPS_CONTEXT_CHAR_CAP = 200_000;

export interface ReferencedStepsLookup {
  getName: (refId: string) => string | undefined;
  getResult: (refId: string) => string | undefined;
}

export interface ReferencedStepsContext {
  text: string;
  bytes: number;
  truncated: boolean;
  stepsIncluded: number;
  stepsSkippedNoResult: number;
}

export const buildReferencedStepsContext = (
  referencedStepIds: readonly string[] | undefined,
  lookup: ReferencedStepsLookup,
): ReferencedStepsContext => {
  if (!referencedStepIds || referencedStepIds.length === 0) {
    return { text: '', bytes: 0, truncated: false, stepsIncluded: 0, stepsSkippedNoResult: 0 };
  }
  const parts: string[] = ['Referenced Steps Results:\n'];
  let runningLen = parts[0].length;
  let stepsIncluded = 0;
  let stepsSkippedNoResult = 0;
  let truncated = false;
  for (const refId of referencedStepIds) {
    const result = lookup.getResult(refId);
    if (!result) {
      stepsSkippedNoResult += 1;
      continue;
    }
    const name = lookup.getName(refId) || `Step ${refId}`;
    const block = `=== ${name} (Step ${refId}) ===\n${result}\n\n`;
    if (runningLen + block.length > REFERENCED_STEPS_CONTEXT_CHAR_CAP) {
      parts.push(
        `[… remaining referenced steps truncated to stay within ${REFERENCED_STEPS_CONTEXT_CHAR_CAP} chars …]\n`,
      );
      truncated = true;
      break;
    }
    parts.push(block);
    runningLen += block.length;
    stepsIncluded += 1;
  }
  if (stepsIncluded === 0 && !truncated) {
    return { text: '', bytes: 0, truncated: false, stepsIncluded: 0, stepsSkippedNoResult };
  }
  const text = parts.join('');
  return { text, bytes: text.length, truncated, stepsIncluded, stepsSkippedNoResult };
};
