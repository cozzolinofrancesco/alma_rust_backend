import { NextRequest, NextResponse } from 'next/server';
import { fetchWithTimeout } from '../../../lib/fetchWithTimeout';
import { DEFAULT_MODEL, isValidModel } from '../../../lib/modelConfig';
import { authorizeServiceRequest } from '../../../lib/serviceApiAuth';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

interface ContentItem {
  role: 'user' | 'model';
  text: string;
}

interface CreateCacheRequest {
  contents: string | ContentItem[];
  systemInstruction?: string;
  displayName?: string;
  model?: string;
  ttl?: string;
}

interface GeminiContentPart {
  text: string;
}

interface GeminiContent {
  role: string;
  parts: GeminiContentPart[];
}

interface GeminiCacheResponse {
  name: string;
  model?: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: {
    totalTokenCount?: number;
  };
}

function resolveModel(raw?: string): string {
  if (!raw) return DEFAULT_MODEL;
  if (raw.toLowerCase() === 'default') return DEFAULT_MODEL;
  return isValidModel(raw) ? raw : DEFAULT_MODEL;
}

function toCachingModelName(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

function buildContents(input: string | ContentItem[]): GeminiContent[] {
  if (typeof input === 'string') {
    return [{ role: 'user', parts: [{ text: input }] }];
  }
  return input.map((item) => ({
    role: item.role,
    parts: [{ text: item.text }],
  }));
}

function buildSystemInstruction(
  text: string | undefined,
): { parts: GeminiContentPart[] } | undefined {
  if (!text?.trim()) return undefined;
  return { parts: [{ text: text.trim() }] };
}

export async function POST(request: NextRequest) {
  const auth = authorizeServiceRequest(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY is not configured' },
      { status: 500 },
    );
  }

  let body: CreateCacheRequest;
  try {
    body = (await request.json()) as CreateCacheRequest;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  if (!body.contents) {
    return NextResponse.json(
      { error: '"contents" is required — provide a string or an array of { role, text } objects' },
      { status: 400 },
    );
  }

  const model = resolveModel(body.model);
  const cachingModel = toCachingModelName(model);

  const requestBody: Record<string, unknown> = {
    model: cachingModel,
    contents: buildContents(body.contents),
  };

  const systemInstruction = buildSystemInstruction(body.systemInstruction);
  if (systemInstruction) requestBody.systemInstruction = systemInstruction;
  if (body.displayName?.trim()) requestBody.displayName = body.displayName.trim();
  if (body.ttl) requestBody.ttl = body.ttl;

  console.log(`🗃️ Gemini Cache: creating cache for model ${cachingModel}`);

  const response = await fetchWithTimeout(
    `${GEMINI_BASE_URL}/v1beta/cachedContents?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
  );

  const data = (await response.json()) as GeminiCacheResponse & { error?: { message?: string } };

  if (!response.ok) {
    const message = data?.error?.message ?? `Gemini API error: ${response.status}`;
    console.error(`❌ Gemini Cache: ${message}`);
    return NextResponse.json({ error: message }, { status: response.status });
  }

  const cacheId = data.name?.split('/').pop() ?? data.name;

  console.log(`✅ Gemini Cache: created cache ${data.name}`);

  return NextResponse.json(
    {
      cacheId,
      name: data.name,
      model: data.model ?? cachingModel,
      displayName: data.displayName,
      expireTime: data.expireTime,
      createTime: data.createTime,
      usageMetadata: data.usageMetadata,
    },
    { status: 201 },
  );
}

export async function GET(request: NextRequest) {
  const auth = authorizeServiceRequest(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY is not configured' },
      { status: 500 },
    );
  }

  const { searchParams } = new URL(request.url);
  const pageSize = searchParams.get('pageSize') ?? '20';
  const pageToken = searchParams.get('pageToken');

  const url = new URL(`${GEMINI_BASE_URL}/v1beta/cachedContents`);
  url.searchParams.set('key', GEMINI_API_KEY);
  url.searchParams.set('pageSize', pageSize);
  if (pageToken) url.searchParams.set('pageToken', pageToken);

  const response = await fetchWithTimeout(url.toString(), { method: 'GET' });
  const data = (await response.json()) as {
    cachedContents?: GeminiCacheResponse[];
    nextPageToken?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    const message = data?.error?.message ?? `Gemini API error: ${response.status}`;
    return NextResponse.json({ error: message }, { status: response.status });
  }

  const caches = (data.cachedContents ?? []).map((c) => ({
    cacheId: c.name?.split('/').pop() ?? c.name,
    name: c.name,
    model: c.model,
    displayName: c.displayName,
    expireTime: c.expireTime,
    createTime: c.createTime,
    usageMetadata: c.usageMetadata,
  }));

  return NextResponse.json({ caches, nextPageToken: data.nextPageToken });
}

export async function DELETE(request: NextRequest) {
  const auth = authorizeServiceRequest(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY is not configured' },
      { status: 500 },
    );
  }

  const { searchParams } = new URL(request.url);
  let cacheName = searchParams.get('name');

  if (!cacheName) {
    try {
      const body = (await request.json()) as { name?: string; cacheId?: string };
      cacheName = body.name ?? (body.cacheId ? `cachedContents/${body.cacheId}` : null);
    } catch {
    }
  }

  if (!cacheName) {
    return NextResponse.json(
      { error: '"name" (e.g. "cachedContents/abc123") or "cacheId" is required' },
      { status: 400 },
    );
  }

  const normalised = cacheName.startsWith('/') ? cacheName.slice(1) : cacheName;

  const response = await fetchWithTimeout(
    `${GEMINI_BASE_URL}/v1beta/${normalised}?key=${GEMINI_API_KEY}`,
    { method: 'DELETE' },
  );

  if (response.status === 204 || response.status === 200) {
    console.log(`🗑️ Gemini Cache: deleted ${cacheName}`);
    return NextResponse.json({ deleted: true, name: cacheName });
  }

  let errMsg = `Gemini API error: ${response.status}`;
  try {
    const data = (await response.json()) as { error?: { message?: string } };
    errMsg = data?.error?.message ?? errMsg;
  } catch {  }

  return NextResponse.json({ error: errMsg }, { status: response.status });
}
