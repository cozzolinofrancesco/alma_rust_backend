export class AgentExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly stage = 'validation',
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}