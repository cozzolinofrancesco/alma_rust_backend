import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getCorpusById } from '@/app/lib/rag/registry';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';
import { normaliseDocumentState, aggregateDocumentStates, type DocumentState } from '@/app/lib/rag/documentState';
import { readOrCreateMeta } from '@/app/lib/agentnodesApi/metaSidecar';
import { PROJECT_META_SCOPE } from '@/app/lib/agentnodesApi/projectCorpusLinksStore';
import { isDevUser } from '@/app/lib/devAccess';
import { google } from 'googleapis';
import { resolveCorpusDocName, type PdfNameSource } from './pdfName';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

interface GeminiDocument {
  name: string;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: string;
  createTime?: string;
  updateTime?: string;
  state?: string;
  customMetadata?: Array<{ key: string; stringValue?: string; numericValue?: number; stringListValue?: string[] }>;
}

interface GeminiDocumentsResponse {
  documents?: GeminiDocument[];
  nextPageToken?: string;
}

export interface CorpusDocument {
  name: string;
  fileId: string | null;
  pdfName: string;
  pdfNameSource: PdfNameSource;
  state: DocumentState;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ corpusId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { corpusId } = await params;

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);
    const corpus = await getCorpusById(corpusId, auth);

    // Resolve the Gemini store. Own-registry corpora resolve directly; a corpus SHARED into
    // the project (project-linking feature) is absent from the caller's registry, so fall
    // back to the project's server-side corpusLinks (which persist the storeName) and, last,
    // to a raw store name passed verbatim (dev parity with the query route). Reading the
    // project sidecar requires the caller's Drive access to the project — that is the authz.
    let storeName = corpus?.corpusId;
    if (!storeName) {
      const projectId = new URL(request.url).searchParams.get('projectId')?.trim();
      if (projectId) {
        try {
          const drive = google.drive({ version: 'v3', auth });
          const { meta } = await readOrCreateMeta(drive, projectId, PROJECT_META_SCOPE);
          const link = (meta.corpusLinks ?? []).find(
            (l) => l.corpusId === corpusId || l.storeName === corpusId,
          );
          if (link?.storeName) storeName = link.storeName;
        } catch (error) {
          console.warn(`[Documents] Could not resolve corpus ${corpusId} via project ${projectId} links:`, error);
        }
      }
      // A raw Gemini store name passed verbatim. Gate behind dev access: only devs are
      // offered cross-user stores by their raw name (the /api/rag/corpora dev-merge), and
      // this branch would otherwise let any caller list an arbitrary store's documents.
      if (!storeName && corpusId.startsWith('fileSearchStores/') && isDevUser(session.user?.email)) {
        storeName = corpusId;
      }
    }

    if (!storeName) {
      return NextResponse.json({ error: 'Corpus not found' }, { status: 404 });
    }

    const allDocuments: GeminiDocument[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${GEMINI_BASE_URL}/v1beta/${storeName}/documents`);
      url.searchParams.set('key', GEMINI_API_KEY);
      url.searchParams.set('pageSize', '20');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const response = await fetchWithTimeout(url.toString(), {});

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Documents] Gemini API error (${response.status}):`, errorText);
        // Degrade gracefully: one corpus whose store errors (deleted, cross-project,
        // transient) must not throw in the document picker and block the whole step.
        // Return 200 with an empty list + a non-blocking warning the UI can surface.
        return NextResponse.json(
          { documents: [], warning: `Could not list documents for this corpus: ${errorText}` },
          { status: 200 }
        );
      }

      const data: GeminiDocumentsResponse = await response.json();
      if (data.documents) allDocuments.push(...data.documents);
      pageToken = data.nextPageToken;
    } while (pageToken);

    if (allDocuments.length > 0) {
      console.log(`[Documents] Sample doc state="${allDocuments[0].state}", keys:`, allDocuments[0].customMetadata?.map(m => m.key));
    }

    // Map file_id → canonical registry filename, for the last-resort name fallback.
    const registryNameByFileId = new Map<string, string>();
    for (const f of corpus?.files ?? []) {
      if (f.fileId) registryNameByFileId.set(f.fileId, f.name);
    }

    // Resolve the display name WITHOUT ever falling back to `displayName` (which is
    // the suffixed chunk name and the source of the query-time filter mismatch).
    // Order: stored pdf_name → strip suffix off chunk_name → file_id→registry → unresolved.
    const toCorpusDoc = (doc: GeminiDocument): CorpusDocument => {
      const meta = doc.customMetadata ?? [];
      const pdfNameMeta = meta.find(m => m.key === 'pdf_name')?.stringValue?.trim();
      const chunkNameMeta = meta.find(m => m.key === 'chunk_name')?.stringValue?.trim();
      const fileId = meta.find(m => m.key === 'file_id')?.stringValue?.trim() || null;

      const { pdfName, pdfNameSource } = resolveCorpusDocName({
        pdfNameMeta,
        chunkNameMeta,
        fileId,
        registryName: fileId ? registryNameByFileId.get(fileId) : undefined,
        displayName: doc.displayName,
        resourceName: doc.name,
      });

      return { name: doc.name, fileId, pdfName, pdfNameSource, state: normaliseDocumentState(doc.state) };
    };

    // Group chunks into selectable documents. Prefer the stable file_id as the key
    // (immune to name issues); fall back to pdfName for pre-file_id corpora.
    const sourceRank: Record<PdfNameSource, number> = { metadata: 3, file_id: 2, chunk_name: 1, unresolved: 0 };
    const groups = new Map<string, { fileId: string | null; pdfName: string; states: DocumentState[]; source: PdfNameSource }>();

    for (const doc of allDocuments) {
      const cd = toCorpusDoc(doc);
      const key = cd.fileId ? `id:${cd.fileId}` : `pdf:${cd.pdfName}`;
      const existing = groups.get(key);
      if (existing) {
        existing.states.push(cd.state);
        // Keep the display name from the most authoritative contributor seen.
        if (cd.pdfName && sourceRank[cd.pdfNameSource] > sourceRank[existing.source]) {
          existing.pdfName = cd.pdfName;
          existing.source = cd.pdfNameSource;
        }
      } else {
        groups.set(key, { fileId: cd.fileId, pdfName: cd.pdfName, states: [cd.state], source: cd.pdfNameSource });
      }
    }

    const documents = Array.from(groups.values()).map(g => ({
      fileId: g.fileId,
      pdfName: g.pdfName,
      pdfNameSource: g.source,
      state: aggregateDocumentStates(g.states),
    }));

    documents.sort((a, b) => a.pdfName.localeCompare(b.pdfName));

    const withFileId = documents.filter(d => d.fileId).length;
    console.log(
      `[Documents] Corpus ${corpusId}: ${allDocuments.length} raw chunks → ${documents.length} unique docs ` +
      `(${withFileId} with file_id; sources: ${documents.map(d => d.pdfNameSource).join(',')})`,
    );

    return NextResponse.json({ documents });
  } catch (error) {
    console.error('Failed to fetch corpus documents:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch documents' },
      { status: 500 }
    );
  }
}
