'use client';

import { useEffect, useState } from 'react';
import type { Pluggable } from 'unified';

export function useRehypeKatex(): Pluggable | null {
  const [plugin, setPlugin] = useState<Pluggable | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      import('rehype-katex'),
      // @ts-expect-error - CSS side-effect import has no type declaration
      import('katex/dist/katex.min.css'),
    ]).then(([mod]) => {
      if (!cancelled) setPlugin(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return plugin;
}
