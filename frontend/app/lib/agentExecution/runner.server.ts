import { AgentExecutionError } from './errors';
import { executionFailure, type ExecutionContext } from './http.server';
import { executePortableStep } from './step.server';
import { advanceSchema, checkpointOutputs, createCheckpoint, createExecutionPlan, materializeAgent, nextStepInputs,
  normalizeAgent, verifyCheckpoint, verifyExecutionPlan } from './planner.server';
import { identifierSchema, planRequestSchema, receiptSchema, type ExecutionCheckpoint } from './schema';

export function planPortableRun(raw: unknown) {
  const plan = createExecutionPlan(raw);
  const checkpoint = createCheckpoint(plan);
  return { schemaVersion: 1, plan, checkpoint, nextInputs: nextStepInputs(plan, checkpoint) };
}

export async function advancePortableRun(raw: unknown, files: Map<string, File>, context: ExecutionContext) {
  const input = advanceSchema.parse(raw);
  const plan = verifyExecutionPlan(input.plan);
  const checkpoint = verifyCheckpoint(input.checkpoint, plan);
  const nextInputs = nextStepInputs(plan, checkpoint);
  if (!nextInputs) {
    if (files.size) throw new AgentExecutionError('UNEXPECTED_FILE', 'A completed run does not accept files.');
    return { status: 200, body: { schemaVersion: 1, status: 'completed', replayed: true,
      checkpoint, updatedAgent: materializeAgent(plan, checkpoint), nextInputs: null } };
  }
  if (checkpoint.status === 'failed' && !input.retryFailed) throw new AgentExecutionError('RUN_FAILED', 'Review the failure, then send retryFailed: true with a new attemptId to retry.', 409);
  context.attemptId = input.attemptId ?? context.attemptId;
  if (checkpoint.attempts.some(attempt => attempt.attemptId === context.attemptId)) throw new AgentExecutionError('ATTEMPT_CONFLICT', 'Use a new attemptId for a new execution attempt.', 409);
  const agent = normalizeAgent(plan.request.bundle.agent);
  const step = agent.layers.find(layer => layer.id === nextInputs.stepId)!;
  try {
    const result = await executePortableStep({
      step, sources: nextInputs.sources, previousOutputs: checkpointOutputs(plan, checkpoint),
      referenceNames: Object.fromEntries(agent.layers.map(layer => [layer.id, layer.name])),
      skills: plan.request.bundle.skills, corpora: agent.metadata.corpusRefs ?? [],
      projectId: plan.request.bundle.projectId, attemptId: context.attemptId,
    }, files, context);
    const receipt = receiptSchema.parse({ stepId: result.stepId, attemptId: result.attemptId,
      output: result.output, diagnostics: result.diagnostics, sources: result.sources, responseMetadata: result.responseMetadata });
    const updated: ExecutionCheckpoint = {
      ...checkpoint, revision: checkpoint.revision + 1,
      completed: [...checkpoint.completed, receipt],
      attempts: [...checkpoint.attempts, { stepId: step.id, attemptId: context.attemptId, status: 'succeeded', finalInferenceAttempted: context.finalInferenceAttempted }],
      status: checkpoint.completed.length + 1 === plan.order.length ? 'completed' : 'ready',
    };
    return { status: 200, body: { schemaVersion: 1, status: updated.status, replayed: false,
      checkpoint: updated, result: receipt, updatedAgent: materializeAgent(plan, updated), nextInputs: nextStepInputs(plan, updated) } };
  } catch (error) {
    const failure = executionFailure(error, context);
    const updated: ExecutionCheckpoint = { ...checkpoint, revision: checkpoint.revision + 1, status: 'failed',
      attempts: [...checkpoint.attempts, { stepId: step.id, attemptId: context.attemptId, status: 'failed', code: failure.body.error.code, finalInferenceAttempted: context.finalInferenceAttempted }] };
    return { status: failure.status, body: { schemaVersion: 1, status: 'failed', ...failure.body,
      checkpoint: updated, updatedAgent: materializeAgent(plan, updated), nextInputs } };
  }
}

const savedStepSchema = planRequestSchema.extend({ stepId: identifierSchema, attemptId: identifierSchema.optional() }).strict();

export async function executeSavedStep(raw: unknown, files: Map<string, File>, context: ExecutionContext) {
  const { attemptId, ...request } = savedStepSchema.parse(raw);
  const { plan, checkpoint } = planPortableRun(request);
  const response = await advancePortableRun({ plan, checkpoint, attemptId }, files, context);
  return { status: response.status, body: { ...response.body, plan } };
}