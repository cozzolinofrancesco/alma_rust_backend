'use client';

import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { useLanguage } from '../../contexts/LanguageContext';
import type { CorpusNodeData } from '../lib/types';

function CorpusNodeImpl({ data }: NodeProps<CorpusNodeData>) {
  const { t } = useLanguage();
  const consumers = data.consumers ?? [];
  const subtitle = useMemo(
    () =>
      consumers.length === 1
        ? t('agentnodesPage.diagram.corpusStepsOne')
        : t('agentnodesPage.diagram.corpusStepsMany', { count: consumers.length }),
    [consumers.length, t],
  );

  const cardTitle = useMemo(
    () => t('agentnodesPage.diagram.corpusNodeTitle', { name: data.name }),
    [data.name, t],
  );
  const cardAria = useMemo(
    () => t('agentnodesPage.diagram.corpusNodeAria', { name: data.name }),
    [data.name, t],
  );

  return (
    <>
      {}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      />

      <div
        className="an-corpus-node"
        role="button"
        tabIndex={0}
        title={cardTitle}
        aria-label={cardAria}
        onClick={() => data.onInspect?.(data.corpusId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            data.onInspect?.(data.corpusId);
          }
        }}
      >
        {}
        <span className="an-corpus-node__icon" aria-hidden>
          <svg viewBox="0 0 28 28" width="26" height="26" focusable="false">
            {}
            <ellipse cx="14" cy="6" rx="8" ry="3" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.5" />
            {}
            <path
              d="M6 6 L6 20 C6 21.7 9.6 23 14 23 C18.4 23 22 21.7 22 20 L22 6"
              fill="currentColor"
              fillOpacity="0.08"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            {}
            <ellipse cx="14" cy="13" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 2" opacity="0.5" />
            {}
            <ellipse cx="14" cy="20" rx="8" ry="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>

        <div className="an-corpus-node__body">
          <div className="an-corpus-node__label">{t('agentnodesPage.diagram.ragCorpusLabel')}</div>
          <div className="an-corpus-node__name" title={data.name}>
            {data.name}
          </div>
          <div className="an-corpus-node__sub">{subtitle}</div>
        </div>

        {}
        <span
          className="an-corpus-node__inspect-hint"
          aria-hidden
          title={t('agentnodesPage.diagram.corpusHintIconTitle')}
        >
          ⓘ
        </span>
      </div>

      {}
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ background: '#64748b', opacity: 0.6, width: 8, height: 8 }}
      />
    </>
  );
}

export default memo(CorpusNodeImpl);
