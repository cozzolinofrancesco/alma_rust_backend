'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface AppBusyContextValue {
  registerBusy: (id: string) => void;
  unregisterBusy: (id: string) => void;
  isBusy: boolean;
}

const AppBusyContext = createContext<AppBusyContextValue | null>(null);

export function AppBusyProvider({ children }: { children: ReactNode }) {
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  const registerBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unregisterBusy = useCallback((id: string) => {
    setBusyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<AppBusyContextValue>(
    () => ({
      registerBusy,
      unregisterBusy,
      isBusy: busyIds.size > 0,
    }),
    [busyIds, registerBusy, unregisterBusy],
  );

  return <AppBusyContext.Provider value={value}>{children}</AppBusyContext.Provider>;
}

export function useAppBusy(): AppBusyContextValue {
  const ctx = useContext(AppBusyContext);
  if (!ctx) {
    throw new Error('useAppBusy must be used within AppBusyProvider');
  }
  return ctx;
}

const NOOP_APP_BUSY: AppBusyContextValue = {
  registerBusy: () => {},
  unregisterBusy: () => {},
  isBusy: false,
};

export function useAppBusyOptional(): AppBusyContextValue {
  const ctx = useContext(AppBusyContext);
  return ctx ?? NOOP_APP_BUSY;
}
