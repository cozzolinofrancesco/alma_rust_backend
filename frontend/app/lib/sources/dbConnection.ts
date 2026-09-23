import { z } from 'zod';

// Database source definitions for the unified validation tool. The `type`
// (engine) field is the discriminant: selecting it in the UI swaps the visible
// field set, and the server validates the matching variant with zod.
//
// SECURITY: `password` / `file` contents are secrets. They are accepted at this
// boundary, stored server-side only (see dbConnectionStore.ts), and never
// returned to the client — the client gets DbConnectionPublic with hasSecret.

export const DB_ENGINES = ['postgres', 'mysql', 'mssql', 'sqlite'] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

// Engines listed in the matrix but not yet wired to a driver. The form may show
// them as "coming soon"; the API rejects them so we never half-connect.
export const DB_ENGINES_PLANNED = ['mongodb', 'bigquery', 'snowflake'] as const;

export const DEFAULT_PORT: Record<Exclude<DbEngine, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
};

const sslMode = z.enum(['disable', 'require', 'verify']);
export type SslMode = z.infer<typeof sslMode>;

// Shared fields for the networked relational engines.
const networked = z.object({
  label: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().positive().max(65535),
  database: z.string().min(1).max(128),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024), // secret
  ssl: sslMode.default('require'),
  // Read-only is locked on in the UI and enforced again at query time. We accept
  // only `true` so a client cannot opt out of the read-only contract.
  readOnly: z.literal(true),
});

export const dbConnectionInput = z.discriminatedUnion('type', [
  networked.extend({
    type: z.literal('postgres'),
    schema: z.string().max(128).default('public'),
  }),
  networked.extend({
    type: z.literal('mysql'),
  }),
  networked.extend({
    type: z.literal('mssql'),
    encrypt: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('sqlite'),
    label: z.string().min(1).max(80),
    // Absolute path or upload-staged path to the .sqlite/.db file (server-side).
    file: z.string().min(1).max(1024),
    readOnly: z.literal(true),
  }),
]);
export type DbConnectionInput = z.infer<typeof dbConnectionInput>;

// What the client receives back — every secret stripped, replaced by hasSecret.
export interface DbConnectionPublic {
  id: string;
  type: DbEngine;
  label: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  hasSecret: true;
  status: 'untested' | 'ok' | 'error';
  created_at: string;
}

// How the caller wants to read from a connected database. The query executor
// enforces SELECT-only for `query`; `nl` is generated to SELECT and surfaced for
// review before it ever runs.
export const dbScope = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('tables'), tables: z.array(z.string().min(1)).min(1).max(50) }),
  z.object({ mode: z.literal('query'), sql: z.string().min(1).max(10000) }),
  z.object({ mode: z.literal('nl'), question: z.string().min(3).max(2000) }),
]);
export type DbScope = z.infer<typeof dbScope>;

export function defaultPortFor(engine: DbEngine): number | undefined {
  return engine === 'sqlite' ? undefined : DEFAULT_PORT[engine];
}
