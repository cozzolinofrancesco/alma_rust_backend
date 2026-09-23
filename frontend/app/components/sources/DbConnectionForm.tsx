'use client';

import { useMemo, useState } from 'react';
import {
  DB_ENGINES,
  DB_ENGINES_PLANNED,
  defaultPortFor,
  type DbConnectionInput,
  type DbConnectionPublic,
  type DbEngine,
  type SslMode,
} from '@/app/lib/sources/dbConnection';

// NOTE: strings are hardcoded English for now. Before this mounts in a page,
// extract them into messages/en.json + ja.json (see CLAUDE.md i18n rule).

interface Props {
  onSaved?: (connection: DbConnectionPublic) => void;
  className?: string;
}

const ENGINE_LABEL: Record<DbEngine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
};

const PLANNED_LABEL: Record<(typeof DB_ENGINES_PLANNED)[number], string> = {
  mongodb: 'MongoDB',
  bigquery: 'BigQuery',
  snowflake: 'Snowflake',
};

interface FormState {
  type: DbEngine;
  label: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: SslMode;
  schema: string;
  encrypt: boolean;
  file: string;
}

const INITIAL: FormState = {
  type: 'postgres',
  label: '',
  host: '',
  port: String(defaultPortFor('postgres') ?? ''),
  database: '',
  username: '',
  password: '',
  ssl: 'require',
  schema: 'public',
  encrypt: true,
  file: '',
};

const inputCls =
  'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

function buildPayload(s: FormState): DbConnectionInput {
  const port = Number(s.port);
  switch (s.type) {
    case 'postgres':
      return {
        type: 'postgres', label: s.label, host: s.host, port, database: s.database,
        username: s.username, password: s.password, ssl: s.ssl, schema: s.schema, readOnly: true,
      };
    case 'mysql':
      return {
        type: 'mysql', label: s.label, host: s.host, port, database: s.database,
        username: s.username, password: s.password, ssl: s.ssl, readOnly: true,
      };
    case 'mssql':
      return {
        type: 'mssql', label: s.label, host: s.host, port, database: s.database,
        username: s.username, password: s.password, ssl: s.ssl, encrypt: s.encrypt, readOnly: true,
      };
    case 'sqlite':
      return { type: 'sqlite', label: s.label, file: s.file, readOnly: true };
  }
}

function isComplete(s: FormState): boolean {
  if (!s.label.trim()) return false;
  if (s.type === 'sqlite') return Boolean(s.file.trim());
  return Boolean(s.host.trim() && s.port && s.database.trim() && s.username.trim() && s.password);
}

export default function DbConnectionForm({ onSaved, className }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isNetworked = form.type !== 'sqlite';
  const complete = useMemo(() => isComplete(form), [form]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
    setSaveError(null);
  }

  function onEngineChange(type: DbEngine) {
    setForm((prev) => ({
      ...prev,
      type,
      port: String(defaultPortFor(type) ?? ''),
    }));
    setTestResult(null);
    setSaveError(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/sources/db/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload(form)),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setTestResult(
        data.ok
          ? { ok: true, message: 'Connection succeeded.' }
          : { ok: false, message: data.error ?? 'Connection failed.' }
      );
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Network error.' });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/sources/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(buildPayload(form)),
      });
      const data = (await res.json()) as { connection?: DbConnectionPublic; error?: string };
      if (!res.ok || !data.connection) {
        setSaveError(data.error ?? 'Could not save connection.');
        return;
      }
      onSaved?.(data.connection);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`space-y-4 ${className ?? ''}`}>
      <div>
        <label className={labelCls}>Connection name</label>
        <input
          className={inputCls}
          placeholder="Prod analytics (read-only)"
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
        />
      </div>

      <div>
        <label className={labelCls}>Type</label>
        <select className={inputCls} value={form.type} onChange={(e) => onEngineChange(e.target.value as DbEngine)}>
          {DB_ENGINES.map((e) => (
            <option key={e} value={e}>{ENGINE_LABEL[e]}</option>
          ))}
          {DB_ENGINES_PLANNED.map((e) => (
            <option key={e} value={e} disabled>{PLANNED_LABEL[e]} (coming soon)</option>
          ))}
        </select>
      </div>

      {isNetworked ? (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Host / endpoint</label>
              <input className={inputCls} placeholder="db.internal.acme.io"
                value={form.host} onChange={(e) => set('host', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Port</label>
              <input className={inputCls} inputMode="numeric"
                value={form.port} onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Database</label>
              <input className={inputCls} placeholder="analytics"
                value={form.database} onChange={(e) => set('database', e.target.value)} />
            </div>
            {form.type === 'postgres' && (
              <div>
                <label className={labelCls}>Schema</label>
                <input className={inputCls} value={form.schema}
                  onChange={(e) => set('schema', e.target.value)} />
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Username</label>
              <input className={inputCls} placeholder="reporting_ro" autoComplete="off"
                value={form.username} onChange={(e) => set('username', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Password 🔒</label>
              <input className={inputCls} type="password" autoComplete="new-password"
                value={form.password} onChange={(e) => set('password', e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>SSL / TLS</label>
              <select className={inputCls} value={form.ssl} onChange={(e) => set('ssl', e.target.value as SslMode)}>
                <option value="disable">disable</option>
                <option value="require">require</option>
                <option value="verify">verify (validate cert)</option>
              </select>
            </div>
            {form.type === 'mssql' && (
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.encrypt}
                    onChange={(e) => set('encrypt', e.target.checked)} />
                  Encrypt connection
                </label>
              </div>
            )}
          </div>
        </>
      ) : (
        <div>
          <label className={labelCls}>Database file path (server-side)</label>
          <input className={inputCls} placeholder="/data/app.sqlite"
            value={form.file} onChange={(e) => set('file', e.target.value)} />
          <p className="text-xs text-gray-400 mt-1">Opened read-only; the file must already exist on the server.</p>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
        <input type="checkbox" checked readOnly className="cursor-not-allowed" />
        <span className="text-sm text-gray-600">Read-only access (locked — writes are never issued)</span>
      </div>

      {testResult && (
        <p className={`text-sm ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>{testResult.message}</p>
      )}
      {saveError && <p className="text-sm text-red-600">{saveError}</p>}

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          disabled={!complete || testing}
          onClick={handleTest}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          disabled={!complete || saving}
          onClick={handleSave}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save & continue'}
        </button>
      </div>
    </div>
  );
}
