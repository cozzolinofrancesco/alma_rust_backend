'use client';

import { ReactNode } from 'react';
import { ThemeProvider } from '../contexts/ThemeContext';

export default function Canvas272Layout({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <div className="h-full min-h-0 flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </ThemeProvider>
  );
}
