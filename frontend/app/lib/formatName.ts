export function formatDisplayName(name: string): string {
  if (!name) return '';

  return name
    .replace(/[._-]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function getDisplayNameFromEmail(email: string, providedName?: string): string {
  if (providedName && providedName.trim()) {
    return providedName;
  }

  const username = email.split('@')[0];
  return formatDisplayName(username);
}
