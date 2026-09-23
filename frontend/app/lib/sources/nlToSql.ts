import { DEFAULT_MODEL } from '@/app/lib/modelConfig';
import { geminiChat, type ChatMessage } from '@/app/lib/gemini';
import type { DbEngine } from './dbConnection';
import type { TableSchema } from './drivers';
import { MAX_ROWS } from './drivers';

// Dialect-aware natural-language → SQL generation. The engine is already known
// from the stored connection, so we tell the model exactly which dialect to
// target (identifier quoting + row-limit syntax) and feed it the introspected
// schema. The caller is responsible for validating the result with sqlGuard and
// running it through the read-only driver — this module never executes anything.

export class NlToSqlError extends Error {}

const MAX_COLS_PER_TABLE = 40;

interface DialectHint {
  quote: string; // example of how identifiers are quoted
  limit: string; // how to cap rows
}

const DIALECT: Record<DbEngine, DialectHint> = {
  postgres: { quote: '"double quotes"', limit: `append LIMIT ${MAX_ROWS}` },
  sqlite: { quote: '"double quotes"', limit: `append LIMIT ${MAX_ROWS}` },
  mysql: { quote: '`backticks`', limit: `append LIMIT ${MAX_ROWS}` },
  mssql: { quote: '[square brackets]', limit: `use SELECT TOP ${MAX_ROWS} (never LIMIT)` },
};

function renderSchema(schema: TableSchema[]): string {
  if (schema.length === 0) return '(no tables found)';
  return schema
    .map(t => {
      const cols = t.columns
        .slice(0, MAX_COLS_PER_TABLE)
        .map(c => `${c.name} ${c.type}`.trim())
        .join(', ');
      return `- ${t.table}(${cols})`;
    })
    .join('\n');
}

function stripSqlFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```sql')) s = s.slice(6);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

export async function generateSql(args: {
  engine: DbEngine;
  schema: TableSchema[];
  question: string;
}): Promise<string> {
  const { engine, schema, question } = args;
  const hint = DIALECT[engine];

  const systemInstruction: ChatMessage = {
    role: 'system',
    text: `You are a senior data analyst that writes a single read-only SQL SELECT for a ${engine} database. Rules:
- Output ONLY the SQL, no prose, no markdown.
- Exactly ONE statement. It MUST be a SELECT (or a read-only WITH … SELECT). Never write INSERT/UPDATE/DELETE/DDL.
- Quote identifiers using ${hint.quote} for this dialect.
- Cap the result set: ${hint.limit}.
- Only reference tables and columns that appear in the provided schema. If the question cannot be answered from the schema, return: SELECT 'no matching data' AS note;`,
  };

  const messages: ChatMessage[] = [
    {
      role: 'user',
      text: `SCHEMA:\n${renderSchema(schema)}\n\nQUESTION: ${question}\n\nReturn the SQL only.`,
    },
  ];

  const raw = await geminiChat(messages, DEFAULT_MODEL, systemInstruction);
  if (!raw || !raw.trim()) {
    throw new NlToSqlError('The model did not return any SQL.');
  }
  const sql = stripSqlFences(raw);
  if (!sql) throw new NlToSqlError('The model returned empty SQL.');
  return sql;
}
