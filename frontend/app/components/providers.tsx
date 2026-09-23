'use client';

import { RootProvider } from "./RootProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider>
      {children}
    </RootProvider>
  );
}
