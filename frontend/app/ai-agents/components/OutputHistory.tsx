'use client';

import { useId, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Download, GitCompareArrows, History, X } from 'lucide-react';
import type { Canvas272Layer } from '../../canvas-272/lib/types';
import OutputComparison from './OutputComparison';
import styles from './OutputHistory.module.css';

type OutputLayer = Pick<Canvas272Layer, 'id' | 'name' | 'outputHistory'>;

export default function OutputHistory({ layers, toolbar = false, showSummary = true }: { layers: readonly OutputLayer[]; toolbar?: boolean; showSummary?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [selectedLayerId, setSelectedLayerId] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [earlierVersion, setEarlierVersion] = useState<number | null>(null);
  const [mode, setMode] = useState<'history' | 'compare'>('history');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const availableLayers = layers.filter(layer => (layer.outputHistory?.length ?? 0) > 0);
  const selectedLayer = availableLayers.find(layer => layer.id === selectedLayerId) ?? availableLayers[0];
  const versions = [...(selectedLayer?.outputHistory ?? [])].sort((first, second) => first.version - second.version);
  const latest = versions.at(-1);
  const selectedOutput = versions.find(version => version.version === selectedVersion) ?? latest;
  const earlierVersions = versions.filter(version => version.version < (selectedOutput?.version ?? 0));
  const earlierOutput = earlierVersions.find(version => version.version === earlierVersion) ?? earlierVersions.at(-1);
  const comparableLayer = availableLayers.find(layer => (layer.outputHistory?.length ?? 0) > 1);

  if (!selectedLayer || !selectedOutput || !latest) return null;

  const openHistory = () => {
    setSelectedLayerId(selectedLayer.id);
    setSelectedVersion(latest.version);
    setMode('history');
    setCopyStatus('idle');
    dialogRef.current?.showModal();
  };

  const openComparison = () => {
    const layer = versions.length > 1 ? selectedLayer : comparableLayer;
    if (!layer) return;
    const pair = [...(layer.outputHistory ?? [])].sort((first, second) => first.version - second.version).slice(-2);
    setSelectedLayerId(layer.id);
    setEarlierVersion(pair[0].version);
    setSelectedVersion(pair[1].version);
    setMode('compare');
    setCopyStatus('idle');
    dialogRef.current?.showModal();
  };

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(selectedOutput.result);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  const downloadOutput = () => {
    const url = URL.createObjectURL(new Blob([selectedOutput.result], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    const name = selectedLayer.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60) || 'output';
    link.href = url;
    link.download = `${name}_v${selectedOutput.version}_${selectedOutput.timestamp.replace(/[:.]/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`${styles.control} ${toolbar ? styles.toolbar : ''}`}>
      {toolbar && availableLayers.length > 1 && (
        <label className={styles.toolbarStep}>
          <span>Saved step output</span>
          <select value={selectedLayer.id} onChange={event => { setSelectedLayerId(event.target.value); setSelectedVersion(null); setEarlierVersion(null); }}>
            {availableLayers.map(layer => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
          </select>
        </label>
      )}
      {showSummary && (availableLayers.length === 1 || toolbar) && (
        <span className={styles.summary}>
          {toolbar && <span className={styles.versionDot} aria-hidden="true"><Check size={16} /></span>}
          v{latest.version}{' '}
          <time dateTime={latest.timestamp} title={latest.timestamp}>{new Date(latest.timestamp).toLocaleString()}</time>
        </span>
      )}
      <button
        type="button"
        className={styles.compareButton}
        title={comparableLayer ? 'Compare completed outputs' : 'Two completed versions required'}
        disabled={!comparableLayer}
        onClick={openComparison}
      >
        <GitCompareArrows size={16} aria-hidden="true" />
        <span>{availableLayers.length === 1 && versions.length > 1 ? `Compare v${versions[versions.length - 2].version} vs v${latest.version}` : 'Compare outputs'}</span>
      </button>
      <button type="button" className={styles.iconButton} title="Output history" aria-label="Output history" onClick={openHistory}>
        <History size={16} aria-hidden="true" />
      </button>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={headingId}
        onKeyDown={event => event.stopPropagation()}
        onClick={event => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}
      >
        <header className={styles.header}>
          <h2 id={headingId}>{mode === 'compare' ? 'Compare outputs' : 'Output history'}</h2>
          <button type="button" className={styles.iconButton} title="Close" aria-label={mode === 'compare' ? 'Close comparison' : 'Close output history'} onClick={() => dialogRef.current?.close()}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className={`${styles.selectors} ${mode === 'compare' ? styles.comparisonSelectors : ''}`}>
          <label>
            <span>Step</span>
            <select
              value={selectedLayer.id}
              onChange={event => {
                setSelectedLayerId(event.target.value);
                const outputs = [...(availableLayers.find(layer => layer.id === event.target.value)?.outputHistory ?? [])].sort((first, second) => first.version - second.version);
                setSelectedVersion(outputs.at(-1)?.version ?? null);
                setEarlierVersion(outputs.at(-2)?.version ?? null);
                setCopyStatus('idle');
              }}
            >
              {availableLayers.filter(layer => mode !== 'compare' || (layer.outputHistory?.length ?? 0) > 1).map(layer => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
            </select>
          </label>
          {mode === 'compare' && (
            <label>
              <span>Earlier version</span>
              <select value={earlierOutput?.version ?? ''} onChange={event => setEarlierVersion(Number(event.target.value))}>
                {earlierVersions.map(version => (
                  <option key={version.version} value={version.version}>v{version.version} - {new Date(version.timestamp).toLocaleString()}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>{mode === 'compare' ? 'Later version' : 'Version'}</span>
            <select
              value={selectedOutput.version}
              onChange={event => {
                setSelectedVersion(Number(event.target.value));
                setCopyStatus('idle');
              }}
            >
              {[...versions].reverse().filter(version => mode !== 'compare' || version.version > versions[0].version).map(version => (
                <option key={version.version} value={version.version}>
                  v{version.version} - {version.version === latest.version ? 'Latest' : 'Previous'} - {new Date(version.timestamp).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {mode === 'history' && <div className={styles.actions}>
            <button type="button" className={styles.iconButton} title="Copy output" aria-label="Copy output" disabled={!selectedOutput.result} onClick={copyOutput}>
              {copyStatus === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            </button>
            <button type="button" className={styles.iconButton} title="Download output" aria-label="Download output" disabled={!selectedOutput.result} onClick={downloadOutput}>
              <Download size={16} aria-hidden="true" />
            </button>
          </div>}
        </div>
        <div className={styles.metadata}>
          {mode === 'history' ? (
            <div className={styles.versionMetadata}>
              <span className={styles.versionState} data-state={selectedOutput.version === latest.version ? 'latest' : 'older'}>
                <span className={styles.versionDot} aria-hidden="true">{selectedOutput.version === latest.version ? <Check size={16} /> : <History size={16} />}</span>
                {selectedOutput.version === latest.version ? `Latest output: v${selectedOutput.version}` : `Older version: v${selectedOutput.version}`}
              </span>
              <time dateTime={selectedOutput.timestamp} title={selectedOutput.timestamp}>{new Date(selectedOutput.timestamp).toLocaleString()}</time>
              {selectedOutput.version !== latest.version && (
                <button type="button" className={styles.compareButton} onClick={() => { setSelectedVersion(latest.version); setCopyStatus('idle'); }}>
                  <ArrowRight size={16} aria-hidden="true" /> Return to latest
                </button>
              )}
            </div>
          ) : <span>v{earlierOutput?.version} to v{selectedOutput.version}</span>}
          <span role="status">{copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Copy failed' : ''}</span>
        </div>
        {mode === 'compare' && earlierOutput ? (
          <div className={styles.content}><OutputComparison earlier={earlierOutput} later={selectedOutput} /></div>
        ) : <div className={`${styles.content} ${styles.versionContent}`} data-version-state={selectedOutput.version === latest.version ? 'latest' : 'older'}>
          {selectedOutput.imageUrls.length > 0 && (
            <div className={styles.images}>
              {selectedOutput.imageUrls.map((imageUrl, imageIndex) => (
                <img key={`${imageIndex}-${imageUrl}`} src={imageUrl} alt={`Output v${selectedOutput.version}, image ${imageIndex + 1}`} />
              ))}
            </div>
          )}
          <textarea className={styles.text} aria-label="Output version text" value={selectedOutput.result} readOnly />
        </div>}
      </dialog>
    </div>
  );
}