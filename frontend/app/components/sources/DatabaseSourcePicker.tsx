'use client';

import { useCallback, useEffect, useState } from 'react';
import DbConnectionForm from './DbConnectionForm';
import type { DbConnectionPublic } from '@/app/lib/sources/dbConnection';

// Compact database-source picker for embedding in a validation flow's source
// step: list/select a saved connection (or add one), pick a table, preview rows.
// NOTE: strings are hardcoded English for now (see CLAUDE.md i18n rule).

interface TablePreview {
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

interface Props {
  onTableSelected?: (info: { connectionId: string; table: string }) => void;
  disabled?: boolean;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function DatabaseSourcePicker({ onTableSelected, disabled }: Props) {
  const [connections, setConnections] = useState<DbConnectionPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('');
  const [tables, setTables] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TablePreview | null>(null);
  const [busy, setBusy] = useState(false);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sources/db', { credentials: 'include' });
      const data = (await res.json()) as { connections?: DbConnectionPublic[] };
      setConnections(data.connections ?? []);
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadConnections(); }, [loadConnections]);

  const loadTables = useCallback(async (id: string) => {
    setTables([]);
    setPreview(null);
    setError(null);
    if (!id) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sources/db/${id}/tables`, { credentials: 'include' });
      const data = (await res.json()) as { tables?: string[]; error?: string };
      if (!res.ok || !data.tables) { setError(data.error ?? 'Could not list tables.'); return; }
      setTables(data.tables);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setBusy(false);
    }
  }, []);

  function onSelectConnection(id: string) {
    setSelectedId(id);
    void loadTables(id);
  }

  function onSaved(conn: DbConnectionPublic) {
    setConnections((prev) => [conn, ...prev.filter((c) => c.id !== conn.id)]);
    setAdding(false);
    onSelectConnection(conn.id);
  }

  async function pickTable(table: string) {
    if (!selectedId) return;
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/sources/db/${selectedId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: 'tables', tables: [table] }),
      });
      const data = (await res.json()) as { results?: TablePreview[]; error?: string };
      if (!res.ok || !data.results) { setError(data.error ?? 'Preview failed.'); return; }
      setPreview(data.results[0] ?? null);
      onTableSelected?.({ connectionId: selectedId, table });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">New database connection</h3>
          <button type="button" onClick={() => setAdding(false)} className="text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
        </div>
        <DbConnectionForm onSaved={onSaved} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-600 mb-1">Connection</label>
          <select
            value={selectedId}
            onChange={(e) => onSelectConnection(e.target.value)}
            disabled={disabled || loading}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">{loading ? 'Loading…' : 'Choose a connection'}</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.type})
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={disabled}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          + Add
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {selectedId && tables.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tables</label>
          <div className="flex flex-wrap gap-2">
            {tables.map((tbl) => (
              <button
                key={tbl}
                type="button"
                disabled={busy || disabled}
                onClick={() => void pickTable(tbl)}
                className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${
                  preview?.table === tbl
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
                    : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-indigo-300 hover:bg-indigo-50'
                }`}
              >
                {tbl}
              </button>
            ))}
          </div>
        </div>
      )}

      {preview && (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-700">Preview: {preview.table}</span>
            <span className="text-xs text-gray-500">{preview.rowCount} rows{preview.truncated ? ' (capped)' : ''}</span>
          </div>
          {preview.rows.length > 0 ? (
            <div className="overflow-x-auto max-h-64">
              <table className="min-w-full text-xs border-collapse">
                <thead>
                  <tr>
                    {preview.columns.map((col) => (
                      <th key={col} className="text-left font-medium text-gray-600 border-b border-gray-200 px-2 py-1 whitespace-nowrap">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="even:bg-gray-50/60">
                      {preview.columns.map((col) => (
                        <td key={col} className="border-b border-gray-100 px-2 py-1 text-gray-700 whitespace-nowrap max-w-xs truncate">{cellText(row[col])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-400">No rows.</p>
          )}
        </div>
      )}
    </div>
  );
}
