import { AGENTNODES_EXPORT_FAILED } from './agentnodesExportCodes';

export type ExportAgentGraphFormat = 'png' | 'svg';

export interface ExportAgentGraphOptions {
  format: ExportAgentGraphFormat;
  graphOnly: boolean;
}

function sanitizeFilenameBase(name: string): string {
  const trimmed = name.trim().replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-');
  return trimmed.slice(0, 80) || 'agent-graph';
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function exportAgentGraphImage(
  reactFlowRoot: HTMLElement,
  filenameBase: string,
  opts: ExportAgentGraphOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { toPng, toSvg } = await import('html-to-image');
    const safeBase = sanitizeFilenameBase(filenameBase);
    const ext = opts.format === 'png' ? 'png' : 'svg';
    const suffix = opts.graphOnly ? 'graph' : 'full';
    const filename = `${safeBase}-${suffix}-${Date.now()}.${ext}`;

    const filter = (node: HTMLElement): boolean => {
      const cls = node.classList;
      if (cls?.contains('react-flow__controls')) return false;
      if (cls?.contains('react-flow__minimap')) return false;
      if (cls?.contains('react-flow__attribution')) return false;
      if (opts.graphOnly && cls?.contains('react-flow__background')) return false;
      return true;
    };

    const common = {
      cacheBust: true as const,
      filter,
      skipFonts: true as const,
      backgroundColor: opts.graphOnly ? 'transparent' : '#f8f8f8',
    };

    const dataUrl =
      opts.format === 'png'
        ? await toPng(reactFlowRoot, {
            ...common,
            pixelRatio: Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 2 : 2),
          })
        : await toSvg(reactFlowRoot, common);

    downloadDataUrl(dataUrl, filename);
    return { ok: true };
  } catch {
    return { ok: false, error: AGENTNODES_EXPORT_FAILED };
  }
}
