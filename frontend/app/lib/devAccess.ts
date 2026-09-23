// Dev/admin access feature.
//
// Users on this allow-list can see, search, and RUN every RAG corpus in the Gemini
// project — the whole project shares one File Search namespace under a single key, so
// this bypasses the per-user Drive-registry ownership gate. It is a deliberate
// privilege escalation scoped to developers/testers.
//
// Extend the allow-list without a code change via NEXT_PUBLIC_DEV_EMAILS
// (comma-separated). The NEXT_PUBLIC_ prefix is intentional: the same gate is read on
// the client (to show the corpus-search UI) and on the server (to authorize the
// run-path bypass), so it must be readable in both.

// No emails are hardcoded here — the allow-list is configured entirely via
// NEXT_PUBLIC_DEV_EMAILS (comma-separated) so no personal addresses live in source.
const BUILTIN_DEV_EMAILS: string[] = [];

function envDevEmails(): string[] {
  return (process.env.NEXT_PUBLIC_DEV_EMAILS || '')
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
