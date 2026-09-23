// Client-side helpers for first-login tutorial flags.
//
// Source of truth is a hidden JSON file in the user's Google Drive (see
// app/api/onboarding/route.ts). LocalStorage caches keyed by userId avoid Drive
// round-trips — and flicker — on every page load.

// Bump when the welcome tour content changes to re-show it once per user.
export const CURRENT_ONBOARDING_VERSION = '1.0';

const ONBOARDING_VERSION_PREFIX = 'alma:onboarding-done-v:';

export const isOnboardingVersionDoneCached = (userId: string, version: string): boolean => {
  if (typeof window === 'undefined' || !userId) return false;
  try {
    return localStorage.getItem(`${ONBOARDING_VERSION_PREFIX}${userId}:${version}`) === '1';
  } catch {
    return false;
  }
};

export const setOnboardingVersionDoneCached = (userId: string, version: string): void => {
  if (typeof window === 'undefined' || !userId) return;
  try {
    localStorage.setItem(`${ONBOARDING_VERSION_PREFIX}${userId}:${version}`, '1');
  } catch {
    // localStorage unavailable — Drive remains the source of truth
  }
};

export interface OnboardingStatusResult {
  completed: boolean;
  currentVersion: string;
  completedVersions: string[];
}

// Reads durable, version-gated onboarding status from Drive.
export const fetchOnboardingStatus = async (): Promise<OnboardingStatusResult | null> => {
  try {
    const res = await fetch('/api/onboarding', { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as OnboardingStatusResult;
  } catch {
    return null;
  }
};

// Records the onboarding tour as completed ("Got it") or skipped ("Skip for
// now") for the given version — both mark the version done so it won't re-show.
export const markOnboardingCompleted = async (
  version: string,
  status: 'completed' | 'skipped',
): Promise<boolean> => {
  try {
    const res = await fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, status }),
    });
    return res.ok;
  } catch {
    return false;
  }
};
