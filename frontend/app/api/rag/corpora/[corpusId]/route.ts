import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { google } from 'googleapis';
import { getCorpusById, deleteCorpusFromRegistry, renameCorpus } from '@/app/lib/rag/registry';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { listUserProjectFolders } from '@/app/lib/project-service';
import {
  updateProjectCorpusLinkNameIfPresent,
  removeProjectCorpusLinkIfPresent,
} from '@/app/lib/agentnodesApi/projectCorpusLinksStore';
import { detachCorpusFromProjectAgents } from '@/app/lib/agentnodesApi/handlers';

// Match a corpus by both its registry id and its Gemini store name (steps/links may hold either).
function corpusMatchIds(entry: { id: string; corpusId: string } | null, fallback: string): string[] {
  const ids = entry ? [entry.id, entry.corpusId] : [fallback];
  return ids.filter((x): x is string => Boolean(x));
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

    if (!corpus) {
      return NextResponse.json({ error: 'Corpus not found' }, { status: 404 });
    }

    return NextResponse.json(corpus);
  } catch (error) {
    console.error('Failed to get corpus:', error);
    return NextResponse.json(
      { error: 'Failed to get corpus' },
      { status: 500 }
    );
  }
}

export async function DELETE(
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

    // Capture ids before deletion so we can propagate the removal to project files.
    const entry = await getCorpusById(corpusId, auth);
    const matchIds = corpusMatchIds(entry, corpusId);

    await deleteCorpusFromRegistry(corpusId, auth);

    // Eager propagation: drop the link from every project that references it, and detach it
    // from those projects' steps. Best-effort; never fail the delete on a propagation error.
    try {
      const drive = google.drive({ version: 'v3', auth });
      const projects = await listUserProjectFolders(drive);
      for (const project of projects) {
        const removed = await removeProjectCorpusLinkIfPresent(drive, project.id, matchIds).catch(() => false);
        if (removed) {
          await detachCorpusFromProjectAgents(drive, project.id, matchIds).catch(() => {});
        }
      }
    } catch (propagateError) {
      console.error('Corpus deleted, but project propagation failed:', propagateError);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete corpus:', error);
    return NextResponse.json(
      { error: 'Failed to delete corpus' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ corpusId: string }> }
) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { corpusId } = await params;
    const body = await request.json();
    const { displayName } = body;

    if (!displayName) {
      return NextResponse.json(
        { error: 'Missing displayName field' },
        { status: 400 }
      );
    }

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    await renameCorpus(corpusId, displayName, auth);

    // Eager propagation: update the corpus name in every project that references it, so
    // collaborators see the new name. Best-effort; never fail the rename on a propagation error.
    try {
      const entry = await getCorpusById(corpusId, auth);
      const matchIds = corpusMatchIds(entry, corpusId);
      const drive = google.drive({ version: 'v3', auth });
      const projects = await listUserProjectFolders(drive);
      await Promise.all(
        projects.map((project) =>
          updateProjectCorpusLinkNameIfPresent(drive, project.id, matchIds, displayName).catch(() => false),
        ),
      );
    } catch (propagateError) {
      console.error('Corpus renamed, but project propagation failed:', propagateError);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to rename corpus:', error);
    return NextResponse.json(
      { error: 'Failed to rename corpus' },
      { status: 500 }
    );
  }
}
