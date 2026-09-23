'use client';

import { ThemeProvider } from '../contexts/ThemeContext';
import { IntegrityChainProvider } from '../contexts/IntegrityChainContext';

export default function ClaimValidationLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider initialDark={false}>
      <IntegrityChainProvider>
        <div className="claim-validation-scroll-wrapper">
          {children}
        </div>
      </IntegrityChainProvider>
    </ThemeProvider>
  );
}
