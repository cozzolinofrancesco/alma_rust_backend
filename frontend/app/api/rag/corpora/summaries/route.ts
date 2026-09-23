import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { createJob, updateJob, markJobStarted, setJobOperation, addJobLog } from '@/app/lib/rag/jobRegistry';
import { getCorpusById } from '@/app/lib/rag/registry';
import { queryFileSearchStore } from '@/app/lib/rag/fileSearchStore';
import { DEFAULT_MODEL } from '@/app/lib/modelConfig';
import { createRefreshableAuth, ensureFreshToken } from '@/app/lib/rag/auth';
import { buildSourceSummaryPrompt } from '@/app/lib/reportCreation/sourceSummary';

interface SummaryFileInput {
  id: string;
  name: string;
}

interface SummaryRecord {
  pdf_name: string;
  protocol_number: string;
  title: string;
  summary: string;
  keywords: string[];
}

function extractJsonCandidate(text: string): string | null {
  if (!text) return null;
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]?.trim()) return fencedMatch[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return null;
}

// Parse the model's free-text answer into a summary object without ever
// throwing. File Search can return empty or degenerate output (e.g. a lone
// "}") when grounding is weak or a document failed to import; an unguarded
// JSON.parse on that would abort the whole batch. Returns null on failure so
// the caller can skip that one file and continue.
function safeParseSummaryJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const candidates = [extractJsonCandidate(text), text.trim()];
  for (const candidate of candidates) {
    if (!candidate || !candidate.includes('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate before giving up.
    }
  }
  return null;
}

function normalizeKeywords(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function isSafeSummaryOutputFileName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 220) return false;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) return false;
  if (!trimmed.toLowerCase().endsWith('.json')) return false;
  return true;
}

function normalizeSummary(parsed: Record<string, unknown>, pdfName: string): SummaryRecord {
  return {
    pdf_name: typeof parsed.pdf_name === 'string' && parsed.pdf_name.trim() ? parsed.pdf_name : pdfName,
    protocol_number: typeof parsed.protocol_number === 'string' ? parsed.protocol_number.trim() : '',
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    keywords: normalizeKeywords(parsed.keywords),
  };
}

async function saveJsonToDrive(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  fileName: string,
  payload: unknown
) {
  await drive.files.create({
    requestBody: {
      name: fileName,
      mimeType: 'application/json',
      parents: [folderId],
    },
    media: {
      mimeType: 'application/json',
      body: JSON.stringify(payload, null, 2),
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });
}

async function processSummariesInBackground(
  jobId: string,
  corpusId: string,
  folderId: string,
  files: SummaryFileInput[],
  model: string | undefined,
  auth: ReturnType<typeof createRefreshableAuth>,
  outputFileName: string
) {
  try {
    await markJobStarted(jobId);
    await setJobOperation(jobId, 'initializing', undefined, 0);
    await addJobLog(jobId, {
      level: 'info',
      message: `Starting summary generation for ${files.length} files`
    });
    
    const corpus = await getCorpusById(corpusId, auth);
    if (!corpus) {
      throw new Error('Corpus not found');
    }

    const drive = google.drive({ version: 'v3', auth });
    const summaries: SummaryRecord[] = [];
    const failedFiles: string[] = [];
    const selectedModel = model || DEFAULT_MODEL;

    for (let index = 0; index < files.length; index += 1) {
      await ensureFreshToken(auth);

      const file = files[index];

      await setJobOperation(jobId, 'generating_summary', file.name, index + 1);
      await addJobLog(jobId, {
        level: 'info',
        message: `Generating summary ${index + 1}/${files.length}: ${file.name}`,
        file: file.name
      });

      const prompt = buildSourceSummaryPrompt(file.name, 'corpus');

      // Isolate each file: a query error or an unparseable/empty model
      // response (common when a PDF failed to import into the store) must not
      // abort the whole batch. We record a placeholder for the failed file so
      // the summaries array stays index-aligned with the input file list, then
      // continue with the rest.
      try {
        const result = await queryFileSearchStore(
          corpusId,
          corpus.corpusId,
          [{ role: 'user', text: prompt }],
          'Return JSON only. Do not include any extra text.',
          selectedModel
        );

        const parsed = safeParseSummaryJson(result.response);
        if (!parsed) {
          throw new Error(
            `Model did not return valid JSON (response length ${result.response?.length ?? 0}).`
          );
        }

        summaries.push(normalizeSummary(parsed, file.name));
        await updateJob(jobId, { processedFiles: index + 1 });
        await addJobLog(jobId, {
          level: 'info',
          message: `Completed summary: ${file.name}`,
          file: file.name
        });
      } catch (fileError) {
        const reason = fileError instanceof Error ? fileError.message : String(fileError);
        failedFiles.push(file.name);
        summaries.push(normalizeSummary({}, file.name));
        await updateJob(jobId, { processedFiles: index + 1 });
        await addJobLog(jobId, {
          level: 'warn',
          message: `Skipped summary (${file.name}): ${reason}`,
          file: file.name
        });
      }
    }

    await setJobOperation(jobId, 'saving_to_drive', outputFileName, files.length);
    await addJobLog(jobId, {
      level: 'info',
      message: `Saving summaries to Drive: ${outputFileName}`
    });
    await saveJsonToDrive(drive, folderId, outputFileName, summaries);

    const finalStatus = failedFiles.length > 0 ? 'completed_with_errors' : 'completed';
    const failureNote =
      failedFiles.length > 0
        ? `${failedFiles.length} of ${files.length} file(s) could not be summarized: ${failedFiles.join(', ')}`
        : undefined;
    await addJobLog(jobId, {
      level: failedFiles.length > 0 ? 'warn' : 'info',
      message: failureNote
        ? `Summary generation finished with issues — ${failureNote}`
        : `Summary generation completed: ${files.length} files processed`
    });
    await updateJob(jobId, {
      status: finalStatus,
      processedFiles: files.length,
      error: failureNote,
      currentOperation: undefined,
      currentFile: undefined
    });
  } catch (error) {
    console.error('Summary job failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await addJobLog(jobId, {
      level: 'error',
      message: `Summary job failed: ${errorMessage}`
    });
    await updateJob(jobId, {
      status: 'failed',
      error: errorMessage,
      errorDetails: error,
      currentOperation: undefined,
      currentFile: undefined
    });
  }
}

export async function POST(request: Request) {
  const session = await getApiSession(request);
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { corpusId, folderId, files, model, outputFileName: rawOutputName } = body as {
      corpusId: string;
      folderId: string;
      files: SummaryFileInput[];
      model?: string;
      outputFileName?: string;
    };

    if (!corpusId || !folderId || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const outputFileName =
      typeof rawOutputName === 'string' && isSafeSummaryOutputFileName(rawOutputName)
        ? rawOutputName.trim()
        : `${corpusId}.json`;

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const jobId = await createJob({
      ownerEmail: session.user?.email ?? undefined,
      displayName: `Summary generation (${files.length} files)`,
      folderId,
      totalFiles: files.length,
    });

    processSummariesInBackground(jobId, corpusId, folderId, files, model, auth, outputFileName);

    return NextResponse.json({ jobId, status: 'pending' });
  } catch (error) {
    console.error('Failed to start summary job:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start summary job' },
      { status: 500 }
    );
  }
}
