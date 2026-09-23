'use client';

import 'katex/dist/katex.min.css';
import { useMemo, useState } from 'react';
import nextDynamic from 'next/dynamic';
import { useAgentEditor } from './AgentEditorContext';
import { useOptionalOutputWorkspace } from '../../../agent-workspace/OutputWorkspaceContext';
import { structuredDocToMarkdown } from '../../../canvas-272/lib/exportFormatter';
import { buildStructuredDocByTag } from '../../../agentnodes/lib/tagSections';
import { markdownToCleanHtmlSync } from '../../../canvas-272/lib/markdownToHtml';
import OutputHistory from '../../components/OutputHistory';
import '../../../canvas-272/style.css';

const RenderedView = nextDynamic(() => import('../../../agentnodes/components/export/RenderedView'), {
  ssr: false,
});

// Output view — renders the agent's assembled document. Inside the agent
// workspace it consumes OutputWorkspaceContext: the Edit tab shows an editable
// markdown editor (with toolbar), while Validation/Export show it read-only.
// On routes without the provider it falls back to a plain read-only preview.
export default function OutputView() {
  const { graphAgent } = useAgentEditor();
  const ctx = useOptionalOutputWorkspace();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const fallbackDoc = useMemo(
    () => (!ctx && graphAgent ? buildStructuredDocByTag(graphAgent, {}) : null),
    [ctx, graphAgent],
  );
  const currentDoc = ctx?.currentDoc ?? fallbackDoc;
  const editedMarkdown = ctx?.editedMarkdown ?? '';
  const editing = ctx?.outputTab === 'edit';

  const html = useMemo(() => {
    if (!currentDoc) return '';
    const markdown = editedMarkdown.trim() ? editedMarkdown : structuredDocToMarkdown(currentDoc);
    return markdownToCleanHtmlSync(markdown);
  }, [currentDoc, editedMarkdown]);

  if (!graphAgent || !currentDoc) {
    return (
      <div className="agent-output-view">
        <div className="agent-output-empty">Loading agent…</div>
      </div>
    );
  }

  if (editing && ctx) {
    return (
      <div className="agent-output-view agent-output-view--editing">
        <OutputHistory layers={graphAgent.layers} toolbar />
        <RenderedView
          key={ctx.editorKey}
          doc={currentDoc}
          seedMarkdown={ctx.editedMarkdown}
          onMarkdownChange={ctx.setEditedMarkdown}
        />
      </div>
    );
  }

  return (
    <div className="agent-output-view">
      <OutputHistory layers={graphAgent.layers} toolbar />
      {html.trim() ? (
        <div className="agent-output-doc-wrap">
          <article
            className="agent-output-doc c272-modal__preview markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
            onContextMenu={(e) => {
              if (!ctx) return;
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }}
          />
        </div>
      ) : (
        <div className="agent-output-empty">
          No step output yet — run the agent to see its output here.
        </div>
      )}

      {menu && ctx ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="c272-menu"
            role="menu"
            style={{ position: 'fixed', top: menu.y, left: menu.x, zIndex: 9999 }}
          >
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => {
                ctx.openPreview();
                setMenu(null);
              }}
            >
              Preview document…
            </button>
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => {
                ctx.handleGoogleDoc();
                setMenu(null);
              }}
            >
              Create Google Doc
            </button>
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => {
                ctx.handlePdf();
                setMenu(null);
              }}
            >
              Download PDF
            </button>
            <button
              type="button"
              className="c272-menu__item"
              onClick={() => {
                ctx.handleDocx();
                setMenu(null);
              }}
            >
              Download DOCX
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
