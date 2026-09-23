import type { Claim } from '@/app/claim-validation/types';
import { callGeminiJson } from './geminiRaw';
import { assertReadOnlySelect } from '@/app/lib/sources/sqlGuard';

// Generate a single read-only SELECT that fetches the value(s) needed to check a
// numeric claim, constrained to an allow-list of real tables/columns. The result
// is guarded by assertReadOnlySelect before it is ever sent to a database.

export interface TableSchema {
  table: string;
  columns: string[];
}

const SQL_SCHEMA = {
  type: 'object',
  properties: { sql: { type: 'string' }, rationale: { type: 'string' } },
  required: ['sql'],
};

function describeSchema(schema: TableSchema[]): string {
  return schema.map((t) => `- ${t.table}(${t.columns.join(', ')})`).join('\n');
}

export async function generateSelect(
  claim: Claim,
  schema: TableSchema[],
  model?: string
): Promise<string | null> {
  if (schema.length === 0) return null;

  const raw = await callGeminiJson<{ sql?: string }>({
    model,
    system: [
      'You translate a factual numeric/statistical claim into ONE read-only SQL SELECT that fetches the value(s) needed to verify it.',
      'STRICT RULES:',
      '- Output a SINGLE SELECT statement. No INSERT/UPDATE/DELETE/DDL, no multiple statements, no semicolons beyond an optional trailing one.',
      '- Use ONLY the tables and columns listed in the schema. Do not invent names.',
      '- Prefer an aggregate (COUNT/SUM/AVG) or a tightly filtered row that yields the figure in the claim.',
      '- If the claim cannot be checked against this schema, return an empty string for sql.',
    ].join('\n'),
    parts: [{ text: `SCHEMA (allowed tables/columns):\n${describeSchema(schema)}\n\nCLAIM:\n${claim.claim_text}` }],
    schema: SQL_SCHEMA,
  });

  const sql = (raw.sql ?? '').trim();
  if (!sql) return null;

  const guard = assertReadOnlySelect(sql);
  if (!guard.ok) {
    console.warn(`[nlToSql] rejected generated SQL: ${guard.reason} :: ${sql.slice(0, 200)}`);
    return null;
  }
  return sql;
}
