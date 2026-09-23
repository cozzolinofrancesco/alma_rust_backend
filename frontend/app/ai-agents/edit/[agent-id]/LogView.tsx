'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentEditor } from './AgentEditorContext';
import { fetchAgentActivity, type ActivityEntry } from '../../../lib/agentActivityLog';

// Activity log view — an append-only record of who did what on this agent
// (add/remove step, edit step, corpus link changes). Reads the dedicated
// sidecar file directly, so it's independent of the agent document.

const actorName = (username: string): string =>
  username && username.includes('@') ? username.split('@')[0] : username || 'unknown';

const describe = (entry: ActivityEntry): string => {
  const step = entry.target ? `"${entry.target}"` : 'a step';
  switch (entry.action) {
    case 'add_step':
      return `added step ${step}`;
    case 'remove_step':
      return `removed step ${step}`;
    case 'edit_step':
      return `edited step ${step}`;
    case 'link_corpus':
      return entry.detail
        ? `linked corpus "${entry.detail}" to step ${step}`
        : `linked a corpus to step ${step}`;
    case 'unlink_corpus':
      return `removed the corpus from step ${step}`;
    default:
      return `changed step ${step}`;
  }
};

const formatDay = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? 'Unknown date'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

export default function LogView() {
  const { agentId, projectId } = useAgentEditor();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    if (!projectId || !agentId) {
      setStatus('ready');
      setEntries([]);
      return;
    }
    setStatus('loading');
    try {
      const data = await fetchAgentActivity(projectId, agentId);
      setEntries(data);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, [projectId, agentId]);

  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Newest first, grouped by calendar day.
  const groups = useMemo(() => {
    const sorted = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const byDay = new Map<string, ActivityEntry[]>();
    for (const entry of sorted) {
      const day = formatDay(entry.timestamp);
      const bucket = byDay.get(day);
      if (bucket) bucket.push(entry);
      else byDay.set(day, [entry]);
    }
    return Array.from(byDay.entries());
  }, [entries]);

  return (
    <div className="agent-log-view" style={styles.wrap}>
      <div style={styles.inner}>
        <div style={styles.header}>
          <h2 style={styles.heading}>Activity log</h2>
          <button type="button" style={styles.refresh} onClick={load} disabled={status === 'loading'}>
            {status === 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {status === 'error' ? (
          <div style={styles.empty}>Couldn’t load the activity log. Try refreshing.</div>
        ) : status === 'loading' && entries.length === 0 ? (
          <div style={styles.empty}>Loading activity…</div>
        ) : groups.length === 0 ? (
          <div style={styles.empty}>
            No activity yet — adding, removing, or editing steps will show up here.
          </div>
        ) : (
          groups.map(([day, dayEntries]) => (
            <section key={day} style={styles.section}>
              <div style={styles.dayLabel}>{day}</div>
              <ul style={styles.list}>
                {dayEntries.map((entry, i) => (
                  <li key={`${entry.timestamp}-${i}`} style={styles.row}>
                    <span style={styles.time}>{formatTime(entry.timestamp)}</span>
                    <span style={styles.text}>
                      <strong>{actorName(entry.username)}</strong> {describe(entry)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { height: '100%', overflowY: 'auto', background: '#f7f7fa' },
  inner: { maxWidth: 720, margin: '0 auto', padding: '32px 24px 96px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 20px' },
  heading: { fontSize: 20, fontWeight: 700, color: '#1a1a24', margin: 0 },
  refresh: {
    border: '1px solid #d6d6e0',
    background: '#fff',
    color: '#3a3a48',
    borderRadius: 8,
    padding: '6px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  empty: { padding: 48, textAlign: 'center', color: '#6b6b7b', fontSize: 14 },
  section: { marginBottom: 24 },
  dayLabel: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#8a8a99',
    margin: '0 0 8px',
  },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  row: {
    display: 'flex',
    gap: 12,
    alignItems: 'baseline',
    padding: '8px 12px',
    borderRadius: 8,
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  },
  time: { flex: '0 0 auto', fontSize: 12, color: '#9a9aa8', fontVariantNumeric: 'tabular-nums', minWidth: 52 },
  text: { fontSize: 14, color: '#2a2a36', lineHeight: 1.4 },
};
