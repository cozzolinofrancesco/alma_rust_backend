'use client';

import { useId, useMemo, useState } from 'react';
import diff_match_patch from 'diff-match-patch';
import type { AgentOutputVersion } from '../../lib/agentOutputHistory';
import styles from './OutputHistory.module.css';

interface ComparisonLabels {
  earlier: string;
  later: string;
  inline: string;
  side: string;
  added: string;
  removed: string;
  identical: string;
  layout: string;
}

export default function OutputComparison({ earlier, later, labels, initialLayout = 'inline' }: {
  earlier: AgentOutputVersion;
  later: AgentOutputVersion;
  labels?: Partial<ComparisonLabels>;
  initialLayout?: 'inline' | 'side';
}) {
  const [layout, setLayout] = useState<'inline' | 'side'>(initialLayout);
  const tabsId = useId();
  const differences = useMemo(() => {
    const engine = new diff_match_patch();
    const result = engine.diff_main(earlier.result, later.result);
    engine.diff_cleanupSemantic(result);
    return result;
  }, [earlier.result, later.result]);

  const renderText = (side?: 'earlier' | 'later') => differences.map(([operation, text], index) => {
    if (operation === 0) return <span key={index}>{text}</span>;
    if (operation === 1) return side === 'earlier' ? null : <ins key={index} className={styles.added}>{text}</ins>;
    return side === 'later' ? null : <del key={index} className={styles.removed}>{text}</del>;
  });

  return (
    <div className={styles.comparison}>
      <div className={styles.comparisonToolbar}>
        <div
          className={styles.segmented}
          role="tablist"
          aria-label={labels?.layout ?? 'Comparison layout'}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'inline' : event.key === 'End' ? 'side' : layout === 'inline' ? 'side' : 'inline';
            setLayout(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-layout="${next}"]`)?.focus();
          }}
        >
          {(['inline', 'side'] as const).map(view => (
            <button
              key={view}
              type="button"
              role="tab"
              id={`${tabsId}-${view}`}
              data-layout={view}
              aria-selected={layout === view}
              aria-controls={`${tabsId}-panel`}
              tabIndex={layout === view ? 0 : -1}
              onClick={() => setLayout(view)}
            >
              {view === 'inline' ? labels?.inline ?? 'Inline changes' : labels?.side ?? 'Side by side'}
            </button>
          ))}
        </div>
        <div className={styles.legend} aria-label="Change colors">
          <span className={styles.added}>{labels?.added ?? 'Added'}</span>
          <span className={styles.removed}>{labels?.removed ?? 'Removed'}</span>
        </div>
      </div>
      {earlier.result === later.result && <p className={styles.noChanges}>{labels?.identical ?? 'No text changes'}</p>}
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${layout}`} tabIndex={0}>
        {layout === 'inline' ? (
          <div className={styles.diffText} aria-label="Inline output changes">{renderText()}</div>
        ) : (
          <div className={styles.sideBySide}>
            <section className={styles.comparisonSide} aria-label={labels?.earlier ?? 'Earlier output'}>
              <h3>{labels?.earlier ?? `Earlier: v${earlier.version}`}</h3>
              <time dateTime={earlier.timestamp} title={earlier.timestamp}>{new Date(earlier.timestamp).toLocaleString()}</time>
              <div className={styles.diffText}>{renderText('earlier')}</div>
            </section>
            <section className={styles.comparisonSide} aria-label={labels?.later ?? 'Later output'}>
              <h3>{labels?.later ?? `Later: v${later.version}`}</h3>
              <time dateTime={later.timestamp} title={later.timestamp}>{new Date(later.timestamp).toLocaleString()}</time>
              <div className={styles.diffText}>{renderText('later')}</div>
            </section>
          </div>
        )}
      </div>
      {(earlier.imageUrls.length > 0 || later.imageUrls.length > 0) && (
        <div className={styles.sideBySide}>
          {[earlier, later].map(version => (
            <section key={version.version} className={styles.comparisonSide} aria-label={`Images from v${version.version}`}>
              <h3>Images: v{version.version}</h3>
              <div className={styles.images}>
                {version.imageUrls.map((imageUrl, imageIndex) => (
                  <img key={`${imageIndex}-${imageUrl}`} src={imageUrl} alt={`Output v${version.version}, image ${imageIndex + 1}`} />
                ))}
                {version.imageUrls.length === 0 && <p>No images</p>}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}