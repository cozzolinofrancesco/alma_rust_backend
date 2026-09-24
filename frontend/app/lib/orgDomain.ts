// Server-side organization restriction (FE-AUTHZ-001).
//
// The `@roche.com` gate was previously enforced ONLY in the client component
// AuthGuard.tsx, so any Google account could obtain a valid session and call the
// APIs directly. This helper is the single source of truth used by the server
// chokepoints (NextAuth signIn callback, edge middleware, getApiSession) so the
// restriction is enforced before any protected work runs. Mirrors the regex the
// client AuthGuard uses (subdomains of roche.com allowed).
const ALLOWED_ORG_EMAIL = /@([a-z0-9-]+\.)*roche\.com$/i;

/** Whether an email belongs to the allowed organization domain. */
export function isAllowedOrgEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && ALLOWED_ORG_EMAIL.test(email);
}
