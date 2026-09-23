

export type IntegrityComponentType =
  | 'user_input'
  | 'context_dependency'
  | 'rag_config'
  | 'model_config'
  | 'system_instruction'
  | 'execution_metadata'
  | 'output'
  | 'evidence'
  | 'final_prompt'
  | 'custom';

export interface IntegrityComponent {
  type: IntegrityComponentType;
  label: string;
  value: unknown;
  sha: string;
}

export interface IntegrityRecord {
  id: string;
  name: string;
  timestamp: string;
  components: IntegrityComponent[];
  step_hash: string;
  previous_chain_hash: string | null;
  chain_hash: string;
}

export function stableJSON(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, val === undefined ? null : val])
      );
    }
    return v;
  });
}

export async function computeSha512(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-512', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface CreateIntegrityRecordInput {
  name: string;
  components: Array<{
    type: IntegrityComponentType;
    label: string;
    value: unknown;
  }>;
  previousChainHash: string | null;
}

export async function createIntegrityRecord(
  input: CreateIntegrityRecordInput
): Promise<IntegrityRecord> {
  const id = newUUID();
  const timestamp = new Date().toISOString();

  const components: IntegrityComponent[] = await Promise.all(
    input.components.map(async (c) => ({
      type: c.type,
      label: c.label,
      value: c.value,
      sha: await computeSha512(stableJSON(c.value)),
    }))
  );

  const componentShasConcat = components.map((c) => c.sha).join('|');
  const step_hash = await computeSha512(componentShasConcat);

  const chainInput = `${input.previousChainHash ?? 'GENESIS'}|${step_hash}`;
  const chain_hash = await computeSha512(chainInput);

  return {
    id,
    name: input.name,
    timestamp,
    components,
    step_hash,
    previous_chain_hash: input.previousChainHash,
    chain_hash,
  };
}

export function computeSha512Sync(input: string): string {

  const { createHash } = require('crypto') as { createHash: (alg: string) => { update: (s: string) => { digest: (e: string) => string } } };
  return createHash('sha512').update(input).digest('hex');
}

export function createIntegrityRecordSync(
  input: CreateIntegrityRecordInput
): IntegrityRecord {
  const id = `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date().toISOString();

  const components: IntegrityComponent[] = input.components.map((c) => ({
    type: c.type,
    label: c.label,
    value: c.value,
    sha: computeSha512Sync(stableJSON(c.value)),
  }));

  const componentShasConcat = components.map((c) => c.sha).join('|');
  const step_hash = computeSha512Sync(componentShasConcat);

  const chainInput = `${input.previousChainHash ?? 'GENESIS'}|${step_hash}`;
  const chain_hash = computeSha512Sync(chainInput);

  return {
    id,
    name: input.name,
    timestamp,
    components,
    step_hash,
    previous_chain_hash: input.previousChainHash,
    chain_hash,
  };
}
