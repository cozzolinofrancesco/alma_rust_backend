import { NextResponse } from 'next/server';
import { AgentFileError } from './agentFiles-gdrive';

export function agentFilesErrorResponse(error: unknown): NextResponse {
  if (error instanceof AgentFileError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof Error && error.name === 'AbortError') return NextResponse.json({ error: 'Request cancelled.' }, { status: 499 });
  const code = Number((error as { code?: unknown } | null)?.code);
  if (code === 403 || code === 404) return NextResponse.json({ error: 'The saved file or its original source is unavailable.', code: 'SOURCE_ACCESS_DENIED' }, { status: code });
  return NextResponse.json({ error: 'Unable to access the personal file library. Please retry.', code: 'LIBRARY_UNAVAILABLE' }, { status: 502 });
}