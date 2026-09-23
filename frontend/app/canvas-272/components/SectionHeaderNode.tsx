'use client';

import { memo } from 'react';
import { Bug } from 'lucide-react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { getTagColor } from '../../components/StepReferenceSelector';
import { useLanguage } from '../../contexts/LanguageContext';
import type { SectionNodeData } from '../hooks/useDiagramModel';

function SectionHeaderNodeImpl({ data }: NodeProps<SectionNodeData>) {
  const { t } = useLanguage();
  const tagColors = data.tag ? getTagColor(data.tag) : null;

  const className = ['c272-node', data.isEdited ? 'c272-node--edited' : '']
    .filter(Boolean)
    .join(' ');

  const cardStyle = tagColors
    ? { background: tagColors.bg, borderColor: tagColors.border }
    : undefined;

  const handleColor = tagColors ? tagColors.border : '#c0bbeb';
  const isTB = data.direction === 'TB';

  return (
    <>
      {}
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        isConnectable={!isTB}
        style={!isTB ? { background: handleColor } : { opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      />
      {}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectable={isTB}
        style={isTB ? { background: handleColor } : { opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      />
      <div
        className={className}
        style={cardStyle}
        role="button"
        tabIndex={0}
        onClick={data.onClick ? () => data.onClick!(data.headerLayerId) : undefined}
        onKeyDown={(e) => {
          if (data.onClick && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            data.onClick(data.headerLayerId);
          }
        }}
      >
        {data.corpusId ? (
          <span
            className="c272-node__corpus-indicator"
            title={t('canvas272Page.groundedCorpusTitle')}
            aria-label={t('canvas272Page.groundedCorpusAria')}
          >
            <span aria-hidden>⛁</span>
          </span>
        ) : null}
        {data.hasDebug && data.onOpenDebug ? (
          <button
            type="button"
            className="c272-node__debug-btn"
            title={t('answerDebug.title')}
            aria-label={t('answerDebug.openAria')}
            onClick={(e) => {
              e.stopPropagation();
              data.onOpenDebug!(data.headerLayerId);
            }}
          >
            <Bug size={14} />
          </button>
        ) : null}
        {tagColors && (
          <span
            className="c272-node__tag-pill"
            style={{ borderColor: tagColors.border, background: tagColors.border, color: '#fff' }}
          >
            {data.tag}
          </span>
        )}
        <div
          className="c272-node__title"
          style={tagColors ? { color: tagColors.text } : undefined}
          title={data.headerTitle}
        >
          {data.headerTitle}
        </div>
      </div>
      {}
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        isConnectable={!isTB}
        style={!isTB ? { background: handleColor } : { opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      />
      {}
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        isConnectable={isTB}
        style={isTB ? { background: handleColor } : { opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      />
    </>
  );
}

export default memo(SectionHeaderNodeImpl);
