
import type { StructuredDoc } from './exportFormatter';
import { structuredDocToMarkdown } from './exportFormatter';
import { markdownToCleanHtmlSync } from './markdownToHtml';

const EXPORT_HOST_ATTR = 'data-c272-pdf-export-host';

const PDF_EXPORT_CSS = `
.pdf-export-root {
  font-family: Helvetica, Arial, sans-serif;
  font-size: 11px;
  line-height: 1.45;
  color: #1a2b5b;
  background: #ffffff;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.pdf-export-root h1 {
  font-size: 18px;
  font-weight: bold;
  margin: 0.5em 0 0.35em;
  color: #1a2b5b;
}
.pdf-export-root h2 {
  font-size: 14px;
  font-weight: bold;
  margin: 0.45em 0 0.3em;
  color: #6b21a8;
}
.pdf-export-root h3, .pdf-export-root h4, .pdf-export-root h5, .pdf-export-root h6 {
  font-size: 12px;
  font-weight: bold;
  margin: 0.4em 0 0.25em;
}
.pdf-export-root p { margin: 0.35em 0; }
.pdf-export-root ul, .pdf-export-root ol {
  margin: 0.35em 0;
  padding-left: 1.35em;
}
.pdf-export-root table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
  font-size: 10px;
}
.pdf-export-root th, .pdf-export-root td {
  border: 1px solid #c8c8d0;
  padding: 5px 7px;
  text-align: left;
  vertical-align: top;
}
.pdf-export-root th {
  background: #f3f0fa;
  font-weight: bold;
}
.pdf-export-root pre {
  background: #f6f8fa;
  padding: 8px;
  border-radius: 4px;
  font-size: 9px;
  overflow-x: auto;
  white-space: pre-wrap;
}
.pdf-export-root code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 9px;
}
.pdf-export-root blockquote {
  margin: 0.4em 0;
  padding-left: 0.85em;
  border-left: 3px solid #c4b5fd;
  color: #334155;
}
`;

function appendPdfExportHost(htmlFragment: string): HTMLDivElement {
  const host = document.createElement('div');
  host.setAttribute(EXPORT_HOST_ATTR, 'true');
  host.style.cssText = [
    'position:fixed',
    'left:-12000px',
    'top:0',
    'width:720px',
    'max-width:720px',
    'background:#ffffff',
    'padding:20px 24px',
    'box-sizing:border-box',
  ].join(';');

  const styleEl = document.createElement('style');
  styleEl.textContent = PDF_EXPORT_CSS;

  const root = document.createElement('div');
  root.className = 'pdf-export-root';
  root.innerHTML = htmlFragment;

  host.appendChild(styleEl);
  host.appendChild(root);
  document.body.appendChild(host);
  return host;
}

function removePdfExportHost(host: HTMLDivElement): void {
  if (host.parentNode) {
    host.parentNode.removeChild(host);
  }
}

async function canvasToPaginatedPdf(
  canvas: HTMLCanvasElement,
  fileName: string,
  marginPt: number,
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const maxW = pageW - marginPt * 2;
  const maxH = pageH - marginPt * 2;

  const scale = maxW / canvas.width;
  const scaledTotalH = canvas.height * scale;
  let renderedPt = 0;
  let isFirstPage = true;

  let sliceIterations = 0;
  while (renderedPt < scaledTotalH - 0.5) {
    sliceIterations += 1;
    if (sliceIterations > 5000) {
      throw new Error('PDF pagination exceeded maximum iterations');
    }
    if (!isFirstPage) {
      pdf.addPage();
    }
    isFirstPage = false;

    const remainingPt = scaledTotalH - renderedPt;
    const pageSlicePt = Math.min(maxH, remainingPt);
    const srcYpx = renderedPt / scale;
    const srcHpx = pageSlicePt / scale;

    const sliceHpx = Math.max(1, Math.ceil(srcHpx));
    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = sliceHpx;
    const ctx = sliceCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get 2D context for PDF slice');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
    const availableSrcH = Math.min(canvas.height - Math.floor(srcYpx), sliceHpx);
    ctx.drawImage(
      canvas,
      0,
      Math.floor(srcYpx),
      canvas.width,
      availableSrcH,
      0,
      0,
      canvas.width,
      availableSrcH,
    );

    const imgData = sliceCanvas.toDataURL('image/png', 1.0);
    const drawHpt = Math.min(pageSlicePt, sliceHpx * scale);
    if (drawHpt <= 0 || !Number.isFinite(drawHpt)) {
      throw new Error('PDF slice height invalid');
    }
    pdf.addImage(imgData, 'PNG', marginPt, marginPt, maxW, drawHpt);
    renderedPt += drawHpt;
  }

  pdf.save(fileName);
}

export async function exportStructuredDocToPdf(doc: StructuredDoc, fileName: string): Promise<void> {
  if (typeof document === 'undefined') {
    throw new Error('PDF export requires a browser environment');
  }

  const markdown = structuredDocToMarkdown(doc);
  const htmlFragment = markdownToCleanHtmlSync(markdown);

  const host = appendPdfExportHost(htmlFragment);

  try {
    const { default: html2canvas } = await import('html2canvas');
    const root = host.querySelector('.pdf-export-root') as HTMLElement | null;
    if (!root) {
      throw new Error('PDF export root missing');
    }

    const canvas = await html2canvas(root, {
      scale: 1.75,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      width: root.scrollWidth,
      height: root.scrollHeight,
    });

    await canvasToPaginatedPdf(canvas, fileName, 48);
  } finally {
    removePdfExportHost(host);
  }
}
