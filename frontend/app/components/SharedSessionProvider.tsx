'use client';

import { ReactNode } from 'react';

export { useSharedSession } from './CompatibilityHooks';

export const SharedSessionProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  return <>{children}</>;
}; 