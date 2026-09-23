// Session-scoped guard for the welcome / onboarding modal.
//
// Durable "completed" state now lives in Google Drive (see app/lib/onboardingStatus.ts).
// This only tracks per-session display so the modal doesn't reopen within one
// browser session after being dismissed:
// - sessionStorage `alma:welcome-seen` — shown once per session (a new login = a
//   new session, so it can appear again until the durable Drive flag is set).

const SEEN_SESSION_KEY = 'alma:welcome-seen';

export const wasWelcomeSeenThisSession = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(SEEN_SESSION_KEY) === '1';
  } catch {
    return false;
  }
};

export const markWelcomeSeenThisSession = (): void => {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(SEEN_SESSION_KEY, '1');
  } catch {
    // sessionStorage unavailable — modal may show again, which is acceptable
  }
};
