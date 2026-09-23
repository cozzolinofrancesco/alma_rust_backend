'use client';

import { useEffect, useState, type ReactNode } from 'react';
import AlmaStudioWipModal from './AlmaStudioWipModal';
import { isAlmaStudioWipAccepted, setAlmaStudioWipAccepted } from '../lib/almaStudioWipUtils';

// Gates every Alma Studio route (index + /agent-workspace/[agent-id]) behind a
// one-time "work in progress" acknowledgement. The check runs after mount to
// avoid an SSR/client hydration mismatch on the localStorage-backed flag.
export default function AgentWorkspaceLayout({ children }: { children: ReactNode }) {
  const [showWipModal, setShowWipModal] = useState(false);

  useEffect(() => {
    if (!isAlmaStudioWipAccepted()) {
      setShowWipModal(true);
    }
  }, []);

  useEffect(() => {
    if (!showWipModal) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [showWipModal]);

  const acceptWip = () => {
    setAlmaStudioWipAccepted();
    setShowWipModal(false);
  };

  return (
    <>
      {children}
      <AlmaStudioWipModal isOpen={showWipModal} onAccept={acceptWip} />
    </>
  );
}
