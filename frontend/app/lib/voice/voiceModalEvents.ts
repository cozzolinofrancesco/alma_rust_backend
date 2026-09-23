'use client';

import { useEffect, useState } from 'react';

export const VOICE_MODAL_OPEN_KEY = 'alma_voice_modal_open';
export const VOICE_MODAL_OPEN_EVENT = 'alma:voice-modal-open';

export type VoiceModalOpenDetail = { open: boolean };

function readVoiceModalOpenFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(VOICE_MODAL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function dispatchVoiceModalOpen(open: boolean): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<VoiceModalOpenDetail>(VOICE_MODAL_OPEN_EVENT, { detail: { open } }),
  );
}

/** True while the ALMA voice modal is open (Navbar). Hides bottom editor chrome that would overlap the chat input. */
export function useVoiceModalOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(readVoiceModalOpenFromStorage());

    const onVoiceModalOpen = (event: Event) => {
      const detail = (event as CustomEvent<VoiceModalOpenDetail>).detail;
      if (detail && typeof detail.open === 'boolean') {
        setOpen(detail.open);
      }
    };

    window.addEventListener(VOICE_MODAL_OPEN_EVENT, onVoiceModalOpen);
    return () => window.removeEventListener(VOICE_MODAL_OPEN_EVENT, onVoiceModalOpen);
  }, []);

  return open;
}
