import type { DbConnectionInput, DbEngine, SslMode } from './dbConnection';
import { assertReadOnlySelect } from './sqlGuard';

// Pluggable per-engine drivers. Each driver knows how to test a connection, list
// its tables, preview a table, and run a guarded read-only SELECT. Engines are
// dynamically imported so only the driver in use is loaded (and a broken native
// build, e.g. better-sqlite3, only breaks that one engine).

export const MAX_ROWS = 500;
// Caps on schema introspection so a huge database can't blow up the NL→SQL
// prompt (or the response payload). The agent only needs a representative shape.
const MAX_SCHEMA_TABLES = 80;
const QUERY_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 8_000;

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableSchema {
  table: string;
  columns: ColumnInfo[];
}

export interface DbDriver {
  test(config: DbConnectionInput): Promise<void>;
  listTables(config: DbConnectionInput): Promise<string[]>;
  previewTable(config: DbConnectionInput, table: string): Promise<QueryResult>;
  runSelect(config: DbConnectionInput, sql: string): Promise<QueryResult>;
  // Dialect-aware schema introspection used by the NL→SQL agent. Returns tables
  // with their columns/types so the model can generate a grounded SELECT.
  getSchema(config: DbConnectionInput): Promise<TableSchema[]>;
}

// Group flat (table_name, column_name, data_type) rows into TableSchema[],
// preserving order and capping the number of tables.
function groupSchemaRows(
  rows: Array<Record<string, unknown>>
): TableSchema[] {
  const byTable = new Map<string, ColumnInfo[]>();
  for (const r of rows) {
    const table = String(r.table_name ?? r.table ?? '');
    if (!table) continue;
    if (!byTable.has(table)) {
      if (byTable.size >= MAX_SCHEMA_TABLES) continue;
      byTable.set(table, []);
    }
    byTable.get(table)!.push({
      name: String(r.column_name ?? r.name ?? ''),
      type: String(r.data_type ?? r.type ?? ''),
    });
  }
  return Array.from(byTable.entries()).map(([table, columns]) => ({ table, columns }));
}

function normalizeRows(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  return input.map((r) =>
    r && typeof r === 'object' ? { ...(r as Record<string, unknown>) } : { value: r }
  );
}

function columnsFromRows(rows: Array<Record<string, unknown>>): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!set.has(key)) { set.add(key); seen.push(key); }
    }
  }
  return seen;
}

function capRows(
  rows: Array<Record<string, unknown>>,
  columns: string[]
): QueryResult {
  const truncated = rows.length > MAX_ROWS;
  const capped = truncated ? rows.slice(0, MAX_ROWS) : rows;
  return {
    columns: columns.length ? columns : columnsFromRows(capped),
    rows: capped,
    rowCount: capped.length,
    truncated,
  };
}

// A table name is only ever accepted if it is one the driver itself listed, so
// the quoted identifier in previewTable can never carry injected SQL.
async function assertKnownTable(driver: DbDriver, config: DbConnectionInput, table: string): Promise<void> {
  const tables = await driver.listTables(config);
  if (!tables.includes(table)) {
    throw new Error(`Unknown table "${table}".`);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function pgSsl(mode: SslMode): false | { rejectUnauthorized: boolean } {
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify' };
}

const postgresDriver: DbDriver = {
  async test(config) {
    if (config.type !== 'postgres') throw new Error('engine mismatch');
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: pgSsl(config.ssl), connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    try { await client.query('SELECT 1'); } finally { await client.end(); }
  },
  async listTables(config) {
    if (config.type !== 'postgres') throw new Error('engine mismatch');
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: pgSsl(config.ssl), connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    try {
      const res = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type IN ('BASE TABLE','VIEW')
         ORDER BY table_name`,
        [config.schema]
      );
      return res.rows.map((r: { table_name: string }) => r.table_name);
    } finally { await client.end(); }
  },
  async previewTable(config, table) {
    if (config.type !== 'postgres') throw new Error('engine mismatch');
    await assertKnownTable(postgresDriver, config, table);
    const ident = `"${config.schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
    return postgresDriver.runSelect(config, `SELECT * FROM ${ident} LIMIT ${MAX_ROWS}`);
  },
  async runSelect(config, sql) {
    if (config.type !== 'postgres') throw new Error('engine mismatch');
    const guard = assertReadOnlySelect(sql);
    if (!guard.ok) throw new Error(guard.reason);
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: pgSsl(config.ssl), connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
      const res = await client.query(sql);
      await client.query('ROLLBACK');
      const rows = normalizeRows(res.rows);
      const columns = res.fields?.map((f: { name: string }) => f.name) ?? [];
      return capRows(rows, columns);
    } finally { await client.end(); }
  },
  async getSchema(config) {
    if (config.type !== 'postgres') throw new Error('engine mismatch');
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: pgSsl(config.ssl), connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    try {
      const res = await client.query(
        `SELECT table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1
         ORDER BY table_name, ordinal_position`,
        [config.schema]
      );
      return groupSchemaRows(normalizeRows(res.rows));
    } finally { await client.end(); }
  },
};

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

function mysqlSsl(mode: SslMode): undefined | { rejectUnauthorized: boolean } {
  if (mode === 'disable') return undefined;
  return { rejectUnauthorized: mode === 'verify' };
}

const mysqlDriver: DbDriver = {
  async test(config) {
    if (config.type !== 'mysql') throw new Error('engine mismatch');
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: mysqlSsl(config.ssl), connectTimeout: CONNECT_TIMEOUT_MS,
    });
    try { await conn.query('SELECT 1'); } finally { await conn.end(); }
  },
  async listTables(config) {
    if (config.type !== 'mysql') throw new Error('engine mismatch');
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: mysqlSsl(config.ssl), connectTimeout: CONNECT_TIMEOUT_MS,
    });
    try {
      const [rowsRaw] = await conn.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = ? ORDER BY table_name`,
        [config.database]
      );
      return normalizeRows(rowsRaw).map((r) => String(r.name));
    } finally { await conn.end(); }
  },
  async previewTable(config, table) {
    if (config.type !== 'mysql') throw new Error('engine mismatch');
    await assertKnownTable(mysqlDriver, config, table);
    const ident = `\`${table.replace(/`/g, '``')}\``;
    return mysqlDriver.runSelect(config, `SELECT * FROM ${ident} LIMIT ${MAX_ROWS}`);
  },
  async runSelect(config, sql) {
    if (config.type !== 'mysql') throw new Error('engine mismatch');
    const guard = assertReadOnlySelect(sql);
    if (!guard.ok) throw new Error(guard.reason);
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: mysqlSsl(config.ssl), connectTimeout: CONNECT_TIMEOUT_MS,
    });
    try {
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await conn.query(`SET SESSION MAX_EXECUTION_TIME=${QUERY_TIMEOUT_MS}`);
      const [rowsRaw, fields] = await conn.query(sql);
      const rows = normalizeRows(rowsRaw);
      const columns = Array.isArray(fields)
        ? fields.map((f) => String((f as { name?: string }).name ?? ''))
        : [];
      return capRows(rows, columns.filter(Boolean));
    } finally { await conn.end(); }
  },
  async getSchema(config) {
    if (config.type !== 'mysql') throw new Error('engine mismatch');
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: mysqlSsl(config.ssl), connectTimeout: CONNECT_TIMEOUT_MS,
    });
    try {
      const [rowsRaw] = await conn.query(
        `SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type
         FROM information_schema.columns
         WHERE table_schema = ?
         ORDER BY table_name, ordinal_position`,
        [config.database]
      );
      return groupSchemaRows(normalizeRows(rowsRaw));
    } finally { await conn.end(); }
  },
};

// ---------------------------------------------------------------------------
// SQL Server (mssql)
// ---------------------------------------------------------------------------

const mssqlDriver: DbDriver = {
  async test(config) {
    if (config.type !== 'mssql') throw new Error('engine mismatch');
    const sql = (await import('mssql')).default;
    const pool = new sql.ConnectionPool({
      server: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: QUERY_TIMEOUT_MS,
      options: { encrypt: config.encrypt, trustServerCertificate: config.ssl !== 'verify' },
    });
    await pool.connect();
    try { await pool.request().query('SELECT 1'); } finally { await pool.close(); }
  },
  async listTables(config) {
    if (config.type !== 'mssql') throw new Error('engine mismatch');
    const sql = (await import('mssql')).default;
    const pool = new sql.ConnectionPool({
      server: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: QUERY_TIMEOUT_MS,
      options: { encrypt: config.encrypt, trustServerCertificate: config.ssl !== 'verify' },
    });
    await pool.connect();
    try {
      const res = await pool.request().query(
        `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`
      );
      return normalizeRows(res.recordset).map((r) => String(r.name));
    } finally { await pool.close(); }
  },
  async previewTable(config, table) {
    if (config.type !== 'mssql') throw new Error('engine mismatch');
    await assertKnownTable(mssqlDriver, config, table);
    const ident = `[${table.replace(/]/g, ']]')}]`;
    return mssqlDriver.runSelect(config, `SELECT TOP ${MAX_ROWS} * FROM ${ident}`);
  },
  async runSelect(config, sql) {
    if (config.type !== 'mssql') throw new Error('engine mismatch');
    const guard = assertReadOnlySelect(sql);
    if (!guard.ok) throw new Error(guard.reason);
    const mssql = (await import('mssql')).default;
    const pool = new mssql.ConnectionPool({
      server: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: QUERY_TIMEOUT_MS,
      options: { encrypt: config.encrypt, trustServerCertificate: config.ssl !== 'verify' },
    });
    await pool.connect();
    try {
      const res = await pool.request().query(sql);
      const rows = normalizeRows(res.recordset);
      return capRows(rows, columnsFromRows(rows));
    } finally { await pool.close(); }
  },
  async getSchema(config) {
    if (config.type !== 'mssql') throw new Error('engine mismatch');
    const sql = (await import('mssql')).default;
    const pool = new sql.ConnectionPool({
      server: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: QUERY_TIMEOUT_MS,
      options: { encrypt: config.encrypt, trustServerCertificate: config.ssl !== 'verify' },
    });
    await pool.connect();
    try {
      const res = await pool.request().query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type
         FROM INFORMATION_SCHEMA.COLUMNS
         ORDER BY TABLE_NAME, ORDINAL_POSITION`
      );
      return groupSchemaRows(normalizeRows(res.recordset));
    } finally { await pool.close(); }
  },
};

// ---------------------------------------------------------------------------
// SQLite (better-sqlite3) — opened read-only; the engine itself blocks writes.
// ---------------------------------------------------------------------------

const sqliteDriver: DbDriver = {
  async test(config) {
    if (config.type !== 'sqlite') throw new Error('engine mismatch');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(config.file, { readonly: true, fileMustExist: true });
    try { db.prepare('SELECT 1').get(); } finally { db.close(); }
  },
  async listTables(config) {
    if (config.type !== 'sqlite') throw new Error('engine mismatch');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(config.file, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
        .all();
      return normalizeRows(rows).map((r) => String(r.name));
    } finally { db.close(); }
  },
  async previewTable(config, table) {
    if (config.type !== 'sqlite') throw new Error('engine mismatch');
    await assertKnownTable(sqliteDriver, config, table);
    const ident = `"${table.replace(/"/g, '""')}"`;
    return sqliteDriver.runSelect(config, `SELECT * FROM ${ident} LIMIT ${MAX_ROWS}`);
  },
  async runSelect(config, sql) {
    if (config.type !== 'sqlite') throw new Error('engine mismatch');
    const guard = assertReadOnlySelect(sql);
    if (!guard.ok) throw new Error(guard.reason);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(config.file, { readonly: true, fileMustExist: true });
    try {
      const stmt = db.prepare(sql);
      const rows = normalizeRows(stmt.all());
      const columns = stmt.columns().map((c) => c.name);
      return capRows(rows, columns);
    } finally { db.close(); }
  },
  async getSchema(config) {
    if (config.type !== 'sqlite') throw new Error('engine mismatch');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(config.file, { readonly: true, fileMustExist: true });
    try {
      const tableRows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`)
        .all();
      const tables = normalizeRows(tableRows).map((r) => String(r.name)).slice(0, MAX_SCHEMA_TABLES);
      const schema: TableSchema[] = [];
      for (const table of tables) {
        // PRAGMA can't take a bound param; the name comes from sqlite_master, so
        // it's a known identifier — quote it defensively all the same.
        const info = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all();
        const columns: ColumnInfo[] = normalizeRows(info).map((c) => ({
          name: String(c.name ?? ''),
          type: String(c.type ?? ''),
        }));
        schema.push({ table, columns });
      }
      return schema;
    } finally { db.close(); }
  },
};

const REGISTRY: Record<DbEngine, DbDriver> = {
  postgres: postgresDriver,
  mysql: mysqlDriver,
  mssql: mssqlDriver,
  sqlite: sqliteDriver,
};

export function getDriver(engine: DbEngine): DbDriver {
  return REGISTRY[engine];
}
