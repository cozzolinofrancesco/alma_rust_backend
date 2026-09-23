
export const DISCLAIMER_COOKIE_NAME = 'disclaimer_accepted';
export const DISCLAIMER_COOKIE_DURATION = 24 * 60 * 60 * 1000;

// Bump when the disclaimer content changes to re-record acceptance per user.
export const CURRENT_DISCLAIMER_VERSION = '1.0';

export const isDisclaimerAccepted = (): boolean => {
  if (typeof document === 'undefined') {
    return false;
  }

  const disclaimerCookie = document.cookie
    .split('; ')
    .find(row => row.startsWith(`${DISCLAIMER_COOKIE_NAME}=`));
  
  return !!disclaimerCookie;
};

export const setDisclaimerAccepted = (): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const expirationDate = new Date();
  expirationDate.setTime(expirationDate.getTime() + DISCLAIMER_COOKIE_DURATION);
  
  document.cookie = `${DISCLAIMER_COOKIE_NAME}=true; expires=${expirationDate.toUTCString()}; path=/; SameSite=Lax`;
};

export const clearDisclaimerCookie = (): void => {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${DISCLAIMER_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
};

// Best-effort per-user record of disclaimer acceptance (Drive + central GSheet).
// The cookie above still governs whether the modal shows; this only records the
// acceptance for a signed-in user. Silently ignores 401 (not signed in) and any
// network error — it must never block the disclaimer flow.
export const recordDisclaimerAcceptance = (): void => {
  void fetch('/api/disclaimer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: CURRENT_DISCLAIMER_VERSION }),
  }).catch(() => {
    // ignore — recording is non-critical
  });
};