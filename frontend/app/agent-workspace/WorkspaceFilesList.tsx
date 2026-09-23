'use client';

import { Database } from 'lucide-react';
import { useCorpora } from '../lib/hooks/useCorpora';

// "Files" content in the left nav: lists all RAG databases (corpora), like the
// RAG manager. Read-only. Only mounted when Files mode is active, so the fetch
// runs on demand.
export default function WorkspaceFilesList() {
  const { corpora, loading, error } = useCorpora();

  if (loading) return <div className="aw-nav__hint">Loading databases…</div>;
  if (error) return <div className="aw-nav__hint aw-nav__hint--error">{error}</div>;
  if (corpora.length === 0) return <div className="aw-nav__hint">No RAG databases yet.</div>;

  return (
    <>
      {corpora.map((corpus) => {
        const fileCount = corpus.files?.length ?? 0;
        return (
          <div key={corpus.id} className="aw-file" title={corpus.displayName}>
            <Database size={14} aria-hidden className="aw-file__icon" />
            <span className="aw-file__label">{corpus.displayName}</span>
            <span className="aw-file__count">{fileCount}</span>
          </div>
        );
      })}
    </>
  );
}
