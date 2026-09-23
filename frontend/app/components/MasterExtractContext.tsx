"use client";

import { ReactNode } from "react";

export { useMasterContext } from './CompatibilityHooks';

export interface MasterContextProps {
  masterContextString: string;
  setMasterContextString: (value: string) => void;
}

export function MasterContextProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
