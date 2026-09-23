'use client';

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { IntegrityRecord } from '../lib/integrity';
import type { ChainMetadata } from '../api/integrity/list/route';

interface IntegrityChainContextValue {
  chainLength: number;
  appendRecord: (record: IntegrityRecord) => void;
  getChain: () => IntegrityRecord[];
  clearChain: () => void;
  saveChain: (options?: { label?: string; operationType?: string; projectId?: string }) => Promise<string>;
  listChains: (projectId?: string) => Promise<ChainMetadata[]>;
  loadChain: (filename: string, driveFileId?: string) => Promise<IntegrityRecord[]>;
}

const IntegrityChainContext = createContext<IntegrityChainContextValue | null>(null);

export function IntegrityChainProvider({ children }: { children: React.ReactNode }) {
  const chainRef = useRef<IntegrityRecord[]>([]);
  const [chainLength, setChainLength] = useState(0);

  const appendRecord = useCallback((record: IntegrityRecord) => {
    chainRef.current = [...chainRef.current, record];
    setChainLength(chainRef.current.length);
  }, []);

  const getChain = useCallback((): IntegrityRecord[] => {
    return chainRef.current;
  }, []);

  const clearChain = useCallback(() => {
    chainRef.current = [];
    setChainLength(0);
  }, []);

  const saveChain = useCallback(
    async (options?: { label?: string; operationType?: string; projectId?: string }): Promise<string> => {
      const chain = chainRef.current;
      if (chain.length === 0) throw new Error('Nothing to save – chain is empty.');

      const res = await fetch('/api/integrity/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain,
          label: options?.label,
          operationType: options?.operationType,
          projectId: options?.projectId,
        }),
        credentials: 'include',
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? 'Failed to save chain');
      }

      const data = (await res.json()) as { filename: string };
      return data.filename;
    },
    []
  );

  const listChains = useCallback(async (projectId?: string): Promise<ChainMetadata[]> => {
    const url = projectId
      ? `/api/integrity/list?projectId=${encodeURIComponent(projectId)}`
      : '/api/integrity/list';
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) return [];
      try {
        const body = (await res.json()) as { error?: string };
        console.warn('[Integrity] listChains failed:', res.status, body.error ?? res.statusText);
      } catch {
        console.warn('[Integrity] listChains failed:', res.status);
      }
      return [];
    }
    const data = (await res.json()) as { chains: ChainMetadata[] };
    return data.chains ?? [];
  }, []);

  const loadChain = useCallback(async (filename: string, driveFileId?: string): Promise<IntegrityRecord[]> => {
    const res = await fetch('/api/integrity/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(driveFileId ? { driveFileId } : { filename }),
      credentials: 'include',
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(msg.error ?? `Failed to load chain (${res.status})`);
    }
    const data = (await res.json()) as { chain: IntegrityRecord[] };
    return data.chain ?? [];
  }, []);

  return (
    <IntegrityChainContext.Provider
      value={{ chainLength, appendRecord, getChain, clearChain, saveChain, listChains, loadChain }}
    >
      {children}
    </IntegrityChainContext.Provider>
  );
}

export function useIntegrityChain(): IntegrityChainContextValue {
  const ctx = useContext(IntegrityChainContext);
  if (!ctx) {
    throw new Error('useIntegrityChain must be used within IntegrityChainProvider');
  }
  return ctx;
}
