'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '../contexts/LanguageContext';

function AgentNodesRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentId = searchParams?.get('agent') ?? null;

  useEffect(() => {
    if (agentId) {
      router.replace(`/ai-agents/edit/${encodeURIComponent(agentId)}?view=graph`);
    } else {
      router.replace('/ai-agents');
    }
  }, [agentId, router]);

  return null;
}

function RedirectFallback() {
  const { t } = useLanguage();
  return (
    <div className="c272-root">
      <div className="c272-empty">{t('agentnodesPage.common.loading')}</div>
    </div>
  );
}

export default function AgentNodesPage() {
  return (
    <Suspense fallback={<RedirectFallback />}>
      <AgentNodesRedirect />
    </Suspense>
  );
}
