// Dev/admin access feature.
//
// Users on this allow-list can see, search, and RUN every RAG corpus in the Gemini
// project — the whole project shares one File Search namespace under a single key, so
// this bypasses the per-user Drive-registry ownership gate. It is a deliberate
// privilege escalation scoped to developers/testers.
//
// Extend the allow-list without a code change via DEV_EMAILS (comma-separated).
// FE-PRIVESC-001: this env var is SERVER-only (no NEXT_PUBLIC_ prefix) so the
// allow-list is never inlined into the client bundle / disclosed to the browser.
// The authorization consumers (rag/query, rag/corpora, ...) run server-side and
// pass the server-verified session email, so a server-only read is sufficient.

// No emails are hardcoded here — the allow-list is configured entirely via
// DEV_EMAILS (comma-separated) so no personal addresses live in source.
const BUILTIN_DEV_EMAILS: string[] = [];

function envDevEmails(): string[] {
  return (process.env.DEV_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function devEmails(): string[] {
  return [...new Set([...BUILTIN_DEV_EMAILS.map((e) => e.toLowerCase()), ...envDevEmails()])];
}

export function isDevUser(email?: string | null): boolean {
  if (!email) return false;
  return devEmails().includes(email.trim().toLowerCase());
}
