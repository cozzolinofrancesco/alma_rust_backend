// Persists the user's acknowledgement of the Alma Studio "work in progress"
// notice. Once accepted the notice does not reappear (persistent, unlike the
// 24h disclaimer cookie in disclaimerUtils.ts).

export const ALMA_STUDIO_WIP_STORAGE_KEY = 'alma-studio-wip-accepted';

export const isAlmaStudioWipAccepted = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(ALMA_STUDIO_WIP_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const setAlmaStudioWipAccepted = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(ALMA_STUDIO_WIP_STORAGE_KEY, 'true');
  } catch {
    // localStorage unavailable (private mode / quota) — fail open; the notice
    // will simply reappear next visit rather than blocking the user.
  }
};
