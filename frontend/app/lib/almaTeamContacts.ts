
export const ALMA_GOOGLE_CHAT_SPACE =
  'https://mail.google.com/chat/u/0/#chat/space/AAQAf_PDi18';

export function googleChatDmUrl(email: string): string {
  return `https://mail.google.com/chat/u/0/#chat/dm/${encodeURIComponent(email)}`;
}

export function mailtoUrl(email: string): string {
  return `mailto:${email}`;
}

// Contact addresses are provided via env (no personal emails hardcoded in source).
// Consumers hide the mailto/contact affordance when these resolve to ''.
export const FRANCESCO_EMAIL = process.env.NEXT_PUBLIC_CONTACT_FRANCESCO_EMAIL ?? '';
export const ROBERTO_EMAIL = process.env.NEXT_PUBLIC_CONTACT_ROBERTO_EMAIL ?? '';

export const FRANCESCO_PHOTO = '/images/francesco.png';
export const ROBERTO_PHOTO = '/images/roberto.png';

export const FRANCESCO_LINKEDIN = 'https://www.linkedin.com/in/cozzolinofrancesco/';
