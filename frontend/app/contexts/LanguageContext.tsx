'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import en from '../../messages/en.json';
import ja from '../../messages/ja.json';
import zh from '../../messages/zh.json';

export type Locale = 'en' | 'ja' | 'zh';

const STORAGE_KEY = 'alma-ui-locale';

type MessageDict = typeof en;

const messagesByLocale: Record<Locale, MessageDict> = {
  en,
  ja,
  zh: zh as unknown as MessageDict,
};

function getNested(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const p of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

interface LanguageContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TranslateFn;
  localeHydrated: boolean;
}

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

function formatTemplate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let result = template;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return result;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  const [localeHydrated, setLocaleHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
      if (stored === 'en' || stored === 'ja' || stored === 'zh') {
        setLocaleState(stored);
        try {
          document.documentElement.lang = stored;
        } catch {
        }
      }
    } catch {
    }
    setLocaleHydrated(true);
  }, []);

  useEffect(() => {
    if (!localeHydrated) return;
    try {
      document.documentElement.lang = locale;
    } catch {
    }
  }, [locale, localeHydrated]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
    }
    try {
      document.documentElement.lang = l;
    } catch {
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const primary = getNested(messagesByLocale[locale] as unknown as Record<string, unknown>, key);
      const fallback = getNested(en as unknown as Record<string, unknown>, key);
      const raw = typeof primary === 'string' ? primary : typeof fallback === 'string' ? fallback : key;
      return formatTemplate(raw, vars);
    },
    [locale]
  );

  const value = useMemo(
    () => ({ locale, setLocale, t, localeHydrated }),
    [locale, setLocale, t, localeHydrated],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return ctx;
}
