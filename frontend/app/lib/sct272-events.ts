export const SCT272_REOPEN_EVENT = 'alma:sct272-reopen';

export function isSct272Pathname(pathname: string | null): boolean {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, '') || '/';
  return p.toLowerCase() === '/sct272';
}
