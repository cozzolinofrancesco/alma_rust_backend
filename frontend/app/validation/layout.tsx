'use client';

import { ThemeProvider } from '../contexts/ThemeContext';
import { IntegrityChainProvider } from '../contexts/IntegrityChainContext';

// The unified Validation page can mount the Claim Validation engine, which needs
// the integrity-chain + theme providers (same set its own layout provides).
export default function ValidationLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider initialDark={false}>
      <IntegrityChainProvider>
        <div className="claim-validation-scroll-wrapper">{children}</div>
      </IntegrityChainProvider>
    </ThemeProvider>
  );
}
