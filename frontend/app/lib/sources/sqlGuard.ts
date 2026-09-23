// Read-only SQL gate. The unified validation tool only ever READS from a
// connected database, so we reject anything that is not a single SELECT (or a
// read-only CTE that resolves to a SELECT). This is defence-in-depth on top of
// connecting with a read-only role and a read-only transaction.

const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'truncate', 'alter', 'create',
  'grant', 'revoke', 'merge', 'replace', 'call', 'exec', 'execute',
  'attach', 'detach', 'vacuum', 'pragma', 'copy', 'into', 'set',
  'commit', 'rollback', 'savepoint', 'lock', 'reindex', 'comment',
];

export interface SqlGuardResult {
  ok: boolean;
  reason?: string;
}

// Strips string/identifier literals and comments so keyword scanning doesn't
// trip on the contents of a quoted value (e.g. WHERE note = 'please delete').
function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; } // escaped
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function assertReadOnlySelect(rawSql: string): SqlGuardResult {
  const trimmed = rawSql.trim();
  if (!trimmed) return { ok: false, reason: 'Empty query.' };

  const cleaned = stripLiteralsAndComments(trimmed);

  // Disallow statement chaining. A single trailing semicolon is fine.
  const withoutTrailing = cleaned.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return { ok: false, reason: 'Multiple statements are not allowed; submit a single SELECT.' };
  }

  const firstWord = withoutTrailing.trimStart().split(/[\s(]+/)[0]?.toLowerCase() ?? '';
  if (firstWord !== 'select' && firstWord !== 'with') {
    return { ok: false, reason: 'Only SELECT (or read-only WITH … SELECT) queries are allowed.' };
  }

  const tokens = new Set(
    withoutTrailing.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []
  );
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (tokens.has(kw)) {
      return { ok: false, reason: `Disallowed keyword "${kw.toUpperCase()}" in a read-only query.` };
    }
  }

  // A WITH clause must still resolve to a SELECT, never a data-modifying CTE.
  if (firstWord === 'with' && !tokens.has('select')) {
    return { ok: false, reason: 'WITH clause must contain a SELECT.' };
  }

  return { ok: true };
}
