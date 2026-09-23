'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Clock3, History, Loader2 } from 'lucide-react';
import type { LayerWithOutputHistory } from '../../lib/agentOutputHistory';
import OutputHistory from './OutputHistory';
import styles from './OutputFrame.module.css';

interface OutputFrameProps {
  layer: LayerWithOutputHistory & { id: string; name: string };
  running?: boolean;
  error?: string | null;
  children: ReactNode;
  className?: string;
}

export default function OutputFrame({ layer, running = false, error, children, className = '' }: OutputFrameProps) {
  const versions = [...(layer.outputHistory ?? [])].sort((first, second) => first.version - second.version);
  const latest = versions.at(-1);
  const result = layer.result ?? layer.output ?? '';
  const imageUrls = layer.imageUrls ?? [];
  const displayed = [...versions].reverse().find(version =>
    version.result === result && version.imageUrls.length === imageUrls.length &&
    version.imageUrls.every((imageUrl, index) => imageUrl === imageUrls[index]),
  );
  const hasOutput = Boolean(displayed || result || imageUrls.length);
  const latestVersion = latest?.version ?? 0;
  const previous = useRef({ layerId: layer.id, version: latestVersion, running });
  const [freshVersion, setFreshVersion] = useState<number | null>(null);
  const [completedRunVersion, setCompletedRunVersion] = useState<number | null>(null);

  useEffect(() => {
    const last = previous.current;
    previous.current = { layerId: layer.id, version: latestVersion, running };
    if (last.layerId !== layer.id) {
      setFreshVersion(null);
      setCompletedRunVersion(null);
      return;
    }
    if (running && !last.running) {
      setFreshVersion(null);
      setCompletedRunVersion(null);
    }
    if (latestVersion > last.version) {
      setFreshVersion(latestVersion);
      setCompletedRunVersion(latestVersion);
    }
  }, [layer.id, latestVersion, running]);

  useEffect(() => {
    if (freshVersion === null) return;
    const timer = window.setTimeout(() => setFreshVersion(null), 8000);
    return () => window.clearTimeout(timer);
  }, [freshVersion, layer.id]);

  const generating = running && completedRunVersion !== latestVersion;
  const state = generating ? 'running' : error ? 'error' : !displayed ? 'unversioned' : displayed.version === latestVersion ? 'latest' : 'older';
  const isFresh = state === 'latest' && freshVersion === displayed?.version;
  const title = generating
    ? hasOutput ? 'Regenerating output' : 'Generating output'
    : error
      ? 'Generation failed'
      : displayed
        ? `${state === 'older' ? 'Older version' : isFresh ? 'New output' : 'Latest output'}: v${displayed.version}`
        : hasOutput ? 'Unversioned output' : 'No output yet';
  const timestamp = displayed?.timestamp;
  const date = timestamp ? new Date(timestamp) : null;
  const validDate = date && !Number.isNaN(date.getTime());

  return (
    <section
      className={`${styles.frame} ${isFresh ? styles.fresh : ''} ${className}`}
      data-output-state={state}
      data-output-version={displayed?.version}
      aria-label={`${layer.name} output`}
    >
      <header className={styles.header}>
        <div className={styles.status} role="status" aria-live="polite" aria-atomic="true">
          <span className={styles.dot} aria-hidden="true">
            {generating ? <Loader2 className={styles.spinner} size={17} /> : error ? <AlertCircle size={17} /> : state === 'older' ? <History size={17} /> : displayed ? <Check size={17} /> : <Clock3 size={17} />}
          </span>
          <div className={styles.labels}>
            <strong>{title}</strong>
            {(generating || error) && hasOutput && <span>{error && !generating ? 'Previous output retained' : 'Showing previous output'}{displayed ? `: v${displayed.version}` : ''}</span>}
            {hasOutput && (validDate ? (
              <time dateTime={timestamp} title={timestamp}>
                Generated {date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}
              </time>
            ) : <span>Timestamp unavailable</span>)}
          </div>
        </div>
        <OutputHistory layers={[layer]} showSummary={false} />
      </header>
      {error && !generating && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.body}>{children}</div>
    </section>
  );
}