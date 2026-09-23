export const DAILY_HELP_SHOWN_DATE_KEY = 'alma_daily_help_shown_date';

export const QUESTIONS_CONTACT_INTRO_SEEN_KEY = 'alma_questions_contact_intro_seen';

export function getTodayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function wasDailyHelpShownToday(): boolean {
  try {
    return window.localStorage.getItem(DAILY_HELP_SHOWN_DATE_KEY) === getTodayLocalDate();
  } catch {
    return false;
  }
}

export function markDailyHelpShownToday(): void {
  try {
    window.localStorage.setItem(DAILY_HELP_SHOWN_DATE_KEY, getTodayLocalDate());
  } catch {
  }
}

export function wasQuestionsContactIntroSeen(): boolean {
  try {
    return window.localStorage.getItem(QUESTIONS_CONTACT_INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}
