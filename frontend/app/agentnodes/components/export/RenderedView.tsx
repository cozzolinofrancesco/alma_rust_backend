'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import MarkdownEditorPanel, { type MarkdownEditorPanelHandle } from './MarkdownEditorPanel';
import { structuredDocToMarkdown, type StructuredDoc } from '../../../canvas-272/lib/exportFormatter';

export interface RenderedViewHandle {
  getEditedMarkdown: () => string;
  scrollToSection: (heading: string | null) => void;
}

interface RenderedViewProps {
  doc: StructuredDoc;
  seedMarkdown?: string;
  onMarkdownChange?: (markdown: string) => void;
  outlineFocusHeading?: string | null;
}

const RenderedView = forwardRef<RenderedViewHandle, RenderedViewProps>(
  ({ doc, seedMarkdown, onMarkdownChange, outlineFocusHeading }, ref) => {
    const baseline = useMemo(() => structuredDocToMarkdown(doc), [doc]);
    const [value, setValue] = useState(() =>
      seedMarkdown !== undefined && seedMarkdown.trim().length > 0 ? seedMarkdown : baseline,
    );
    const skipNextBaselineSync = useRef(Boolean(seedMarkdown?.trim()));

    useEffect(() => {
      if (skipNextBaselineSync.current) {
        skipNextBaselineSync.current = false;
        return;
      }
      setValue(baseline);
    }, [baseline]);

    const editorRef = useRef<MarkdownEditorPanelHandle>(null);

    useImperativeHandle(ref, () => ({
      getEditedMarkdown: () => value,
      scrollToSection: (heading) => {
        editorRef.current?.scrollToSection(heading);
      },
    }), [value]);

    return (
      <div className="an-wizard-rendered">
        <div className="an-wizard-editor-shell">
          <MarkdownEditorPanel
            ref={editorRef}
            value={value}
            onChange={(next) => {
              setValue(next);
              onMarkdownChange?.(next);
            }}
            downloadName={doc.agentName || 'document'}
            outlineFocusHeading={outlineFocusHeading}
          />
        </div>
      </div>
    );
  },
);

RenderedView.displayName = 'RenderedView';

export default RenderedView;
