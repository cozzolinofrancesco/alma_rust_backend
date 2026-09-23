import { AgentExecutionError } from './errors';
import type { ExecutionLayer } from './schema';

export function validateExecutableLayer(step: ExecutionLayer) {
  if (!step.userInstruction.trim()) throw new AgentExecutionError('MISSING_INSTRUCTION', `Step ${step.id} needs a user instruction.`);
  if (step.isActive === false || step.isFrozen) throw new AgentExecutionError('INACTIVE_STEP', `Activate and unfreeze step ${step.id} before executing it.`, 409);
  for (const field of ['toolCall', 'functionCall', 'condition', 'inputUrl']) {
    if (step[field]) throw new AgentExecutionError('UNSUPPORTED_STEP_BEHAVIOR', `Step ${step.id} uses ${field}; supply explicit inputs instead.`);
  }
  if (Array.isArray(step.urlContent) && step.urlContent.length) throw new AgentExecutionError('UNBOUND_INPUT', 'Supply URL content as an explicit text source.');
}