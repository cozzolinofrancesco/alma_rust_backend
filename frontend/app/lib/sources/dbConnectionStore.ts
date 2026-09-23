import { randomUUID } from 'node:crypto';
import type { DbConnectionInput, DbConnectionPublic, DbEngine } from './dbConnection';

// In-memory, owner-scoped store for database connections. The full config
// (including secrets) lives only here, server-side; callers outside this module
// only ever receive DbConnectionPublic via toPublic(). State is lost on restart
// by design — users re-enter credentials after a redeploy.
//
// Mirrors the global-Map pattern used by app/claim-validation/lib/jobStore.ts so
// the store survives dev hot-reloads.

const MAX_CONNECTIONS = 200;
const CONNECTION_TTL_MS = 12 * 60 * 60 * 1000;

export interface StoredConnection {
  id: string;
  owner_email: string;
  config: DbConnectionInput; // contains secrets — never leaves the server
  status: DbConnectionPublic['status'];
  created_at: string;
  last_used_at: string;
}

const globalForConnections = global as unknown as {
  dbSourceConnections?: Map<string, StoredConnection>;
};

const connections: Map<string, StoredConnection> =
  globalForConnections.dbSourceConnections || new Map();

if (process.env.NODE_ENV !== 'production') {
  globalForConnections.dbSourceConnections = connections;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [id, conn] of connections.entries()) {
    if (now - new Date(conn.created_at).getTime() > CONNECTION_TTL_MS) {
      connections.delete(id);
    }
  }
}

function enforceCapacity(): void {
  if (connections.size >= MAX_CONNECTIONS) {
    const oldest = [...connections.entries()].sort(
      (a, b) => new Date(a[1].created_at).getTime() - new Date(b[1].created_at).getTime()
    )[0];
    if (oldest) connections.delete(oldest[0]);
  }
}

export function toPublic(conn: StoredConnection): DbConnectionPublic {
  const { config } = conn;
  const base = {
    id: conn.id,
    type: config.type as DbEngine,
    label: config.label,
    hasSecret: true as const,
    status: conn.status,
    created_at: conn.created_at,
  };
  if (config.type === 'sqlite') {
    return base;
  }
  return {
    ...base,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
  };
}

export function saveConnection(
  ownerEmail: string,
  config: DbConnectionInput,
  status: DbConnectionPublic['status']
): StoredConnection {
  evictExpired();
  enforceCapacity();

  const now = new Date().toISOString();
  const conn: StoredConnection = {
    id: randomUUID(),
    owner_email: ownerEmail,
    config,
    status,
    created_at: now,
    last_used_at: now,
  };
  connections.set(conn.id, conn);
  return conn;
}

// Returns the connection only when it belongs to the caller — prevents one user
// from reading another user's stored credentials/config by id.
export function getConnection(id: string, ownerEmail: string): StoredConnection | undefined {
  evictExpired();
  const conn = connections.get(id);
  if (!conn || conn.owner_email !== ownerEmail) return undefined;
  return conn;
}

export function touchConnection(id: string): void {
  const conn = connections.get(id);
  if (conn) conn.last_used_at = new Date().toISOString();
}

export function setStatus(id: string, status: DbConnectionPublic['status']): void {
  const conn = connections.get(id);
  if (conn) conn.status = status;
}

export function listConnections(ownerEmail: string): DbConnectionPublic[] {
  evictExpired();
  return [...connections.values()]
    .filter((c) => c.owner_email === ownerEmail)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(toPublic);
}

export function deleteConnection(id: string, ownerEmail: string): boolean {
  const conn = connections.get(id);
  if (!conn || conn.owner_email !== ownerEmail) return false;
  return connections.delete(id);
}
