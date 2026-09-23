import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { getCorpusById } from '@/app/lib/rag/registry';
import { CorpusAccessError, resolveCallerCorpora } from '@/app/lib/rag/access.server';
import { isDevUser } from '@/app/lib/devAccess';
import { corpusRegistryHaystackForMatching, registryRowMatchesCorpusHints } from '@/app/agentnodes/lib/corpus';

// Pin the Node.js runtime: this route transitively depends on native modules
// (sharp/pdf2pic via fileSearchStore → pdfSplitter → pdfCompressor).
export const runtime = 'nodejs';
// A genuine grounded query (large corpus + big prompt + thinking) can legitimately
// run for minutes — do NOT impose a short cap. The real ceiling is the hosting
// platform's request timeout (Cloud Run ~60 min); this just documents intent for
// platforms that honour it. User Stop / client-disconnect aborts early.
export const maxDuration = 3600;
import { queryFileSearchStore, listAllFileSearchStores } from '@/app/lib/rag/fileSearchStore';
import { rewriteRetrievalQuery } from '@/app/lib/rag/queryRewrite';
import { DEFAULT_MODEL } from '@/app/lib/modelConfig';
import { createRefreshableAuth } from '@/app/lib/rag/auth';
import { google } from 'googleapis';
import type { OAuth2Client } from 'googleapis-common';
import { isGalileoModel } from '@/app/lib/stepModels';
import { galileoStepResponse } from '@/app/lib/galileo/step.server';

// Does the caller's Google account have access to this project Drive folder? A plain
// files.get with the caller's own OAuth token succeeds only if Drive has shared the
// folder with them — so this rides on the project's existing sharing, no extra infra.
async function callerHasProjectAccess(projectId: string, auth: OAuth2Client): Promise<boolean> {
  try {
    const drive = google.drive({ version: 'v3', auth });
    await drive.files.get({ fileId: projectId, fields: 'id', supportsAllDrives: true });
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const session = await getApiSession(request);

  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { corpusId, corpusIds, corpusDisplayHints, projectId, messages, systemInstruction, model, metadataFilter, includeThoughts, thinkingLevel, optimizeQuery } = body;
    if (isGalileoModel(model)) return galileoStepResponse(body, [], session, request.signal);

    // Forward a generation override when the caller sent an explicit reasoning setting.
    // thinkingLevel is validated against the allowed Gemini 3.x set; anything else is dropped
    // so queryFileSearchStore keeps its own bounded default.
    const allowedThinkingLevels = ['minimal', 'low', 'medium', 'high'] as const;
    const validThinkingLevel = allowedThinkingLevels.find((l) => l === thinkingLevel);
    const generationOverride =
      typeof includeThoughts === 'boolean' || validThinkingLevel
        ? {
            ...(typeof includeThoughts === 'boolean' ? { includeThoughts } : {}),
            ...(validThinkingLevel ? { thinkingLevel: validThinkingLevel } : {}),
          }
        : undefined;

    const requestedIds: string[] = Array.isArray(corpusIds) && corpusIds.length > 0
      ? corpusIds
      : corpusId
        ? [corpusId]
        : [];

    if (requestedIds.length === 0 || !messages) {
      return NextResponse.json(
        { error: 'Missing required fields: corpusId (or corpusIds), messages' },
        { status: 400 }
      );
    }

    console.log(`🔍 [API] RAG Query request for corpora: ${requestedIds.join(', ')}`);
    console.log(`📝 [API] Messages count: ${messages.length}`);
    console.log(`🎯 [API] System instruction: ${systemInstruction ? 'Provided' : 'None'}`);
    console.log(`🤖 [API] Model: ${model || 'default'}`);
    console.log(`🔎 [API] Metadata filter: ${metadataFilter || 'none'}`);
    console.log(`🧠 [API] Include thoughts: ${typeof includeThoughts === 'boolean' ? includeThoughts : 'default'} | thinkingLevel: ${validThinkingLevel ?? 'default(low)'} | optimizeQuery: ${optimizeQuery === true}`);

    const auth = createRefreshableAuth(session.accessToken, session.refreshToken);

    const scriptCaller = request.headers.has('x-api-key');
    const resolved = scriptCaller ? [] : await Promise.all(requestedIds.map((id) => getCorpusById(id, auth)));
    let storeNames = scriptCaller ? await resolveCallerCorpora(requestedIds, auth, projectId, request.signal) : [
      ...new Set(
        resolved
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
          .map((c) => c.corpusId),
      ),
    ];

    // Cross-user resolution: when the caller's own registry can't resolve the corpus,
    // resolve against the flat Gemini namespace instead (every store lives under one
    // shared key). Allowed for either (a) a dev on the allow-list, or (b) a member of
    // the project the agent belongs to — verified against the project folder's real
    // Drive sharing. Both let a user run corpora created by OTHER users.
    const devAllowed = !scriptCaller && isDevUser(session.user?.email);
    const projectAllowed =
      !scriptCaller && !devAllowed && typeof projectId === 'string' && projectId.length > 0
        ? await callerHasProjectAccess(projectId, auth)
        : false;
    if (storeNames.length === 0 && (devAllowed || projectAllowed)) {
      const allStores = await listAllFileSearchStores();
      const byName = new Map(allStores.map((s) => [s.name, s]));
      const picked = new Set<string>();

      // (1) A requested id that is already a raw Gemini store name.
      for (const id of requestedIds) {
        if (byName.has(id)) picked.add(id);
      }

      // (2) Otherwise resolve by the corpus display-name hint from the agent JSON.
      // Prefer exact (normalised) name equality; fall back to the fuzzy hint matcher.
      const hints = Array.isArray(corpusDisplayHints)
        ? corpusDisplayHints.filter((h: unknown): h is string => typeof h === 'string' && h.trim().length > 0)
        : [];
      if (picked.size === 0 && hints.length > 0) {
        const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        const hintSet = new Set(hints.map(norm));
        const exact = allStores.filter((s) => hintSet.has(norm(s.displayName)));
        if (exact.length > 0) {
          exact.forEach((s) => picked.add(s.name));
        } else {
          for (const s of allStores) {
            if (registryRowMatchesCorpusHints(corpusRegistryHaystackForMatching({ displayName: s.displayName }), hints)) {
              picked.add(s.name);
            }
          }
        }
      }

      storeNames = [...picked];
      if (storeNames.length > 0) {
        console.warn(
          `🔓 [API] Cross-user corpus access (${devAllowed ? 'dev' : 'project-member'}) for ${session.user?.email}: ` +
          `resolved ${storeNames.length} store(s) from flat namespace ` +
          `(requested: ${requestedIds.join(', ')}${projectAllowed ? `, project: ${projectId}` : ''})`,
        );
      }
    }

    if (storeNames.length === 0) {
      console.error(`❌ [API] No corpora resolved for: ${requestedIds.join(', ')}`);
      return NextResponse.json(
        { error: 'Corpus not found' },
        { status: 404 }
      );
    }

    console.log(`✅ [API] Resolved ${storeNames.length}/${requestedIds.length} store(s): ${storeNames.join(', ')}`);

    // Optional retrieval-query optimization (per-step "Optimize query" toggle):
    // rewrite the last user message into a compact search query before File Search.
    // Server-side (needs the API key); falls back to the original text on any failure.
    let queryMessages = messages;
    if (optimizeQuery === true && Array.isArray(messages) && messages.length > 0) {
      const lastUserIdx = messages.map((m: { role?: string }) => m?.role).lastIndexOf('user');
      const idx = lastUserIdx >= 0 ? lastUserIdx : messages.length - 1;
      const originalText = typeof messages[idx]?.text === 'string' ? messages[idx].text : '';
      if (originalText.trim()) {
        const rewritten = await rewriteRetrievalQuery({
          question: originalText,
          systemInstruction,
          model: typeof model === 'string' && model.length > 0 ? model : DEFAULT_MODEL,
        });
        if (rewritten && rewritten !== originalText) {
          queryMessages = messages.map((m: { role: string; text: string }, i: number) =>
            i === idx ? { ...m, text: rewritten } : m,
          );
          console.log(`✍️ [API] Retrieval query optimized: "${originalText.slice(0, 80)}" → "${rewritten.slice(0, 80)}"`);
        }
      }
    }

    const result = await queryFileSearchStore(
      requestedIds.join(','),
      storeNames,
      queryMessages,
      systemInstruction,
      model,
      metadataFilter,
      undefined,
      generationOverride,
      request.signal,
      scriptCaller ? { allowUngroundedFallback: false, redactLogs: true } : undefined,
    );

    if (result.isGrounded && result.response?.length > 0) {
      console.log(`✅ [API] Query completed — grounded with ${result.groundingChunks?.length ?? 0} chunk(s), ${result.response.length} chars`);
    } else {
      console.warn(`⚠️ [API] Query finished but returned no grounded content — isGrounded=${result.isGrounded}, chars=${result.response?.length ?? 0} (store may be empty, still indexing, or query doesn't match)`);
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CorpusAccessError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    // Client aborted (Stop / navigated away): not a server error.
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('🛑 [API] Query aborted by client');
      return NextResponse.json({ error: 'Query aborted' }, { status: 499 });
    }
    const errMessage = error instanceof Error ? error.message : 'Failed to query corpus';
    const errStack = error instanceof Error ? error.stack : undefined;
    console.error('❌ [API] Query error:', errMessage);
    if (errStack) console.error('❌ [API] Stack:', errStack);
    return NextResponse.json(
      { error: errMessage },
      { status: 500 }
    );
  }
}
