import { fetchWithTimeout } from './fetchWithTimeout';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export interface CachedContentMessage {
  role: 'user' | 'model';
  text: string;
}

export interface CachedContentInput {
  model: string;
  systemInstruction?: string;
  contents?: CachedContentMessage[];
  ttl?: string;
}

export interface CachedContentObject {
  name: string;
  model?: string;
  displayName?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: { totalTokenCount?: number };
}

interface CachedContentListResponse {
  cachedContents?: CachedContentObject[];
}

function toModelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

function cachedContentsEndpoint(suffix = ''): string {
  return `${GEMINI_BASE_URL}/v1beta/cachedContents${suffix}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
}

function assertApiKey(): void {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  return `Gemini cache API ${response.status}: ${body}`;
}

export async function createCachedContent(input: CachedContentInput): Promise<CachedContentObject> {
  assertApiKey();

  const systemText = input.systemInstruction?.trim();
  const hasContents = Array.isArray(input.contents) && input.contents.length > 0;
  if (!systemText && !hasContents) {
    throw new Error('Nothing to cache: provide a systemInstruction and/or contents.');
  }

  const body: Record<string, unknown> = {
    model: toModelPath(input.model),
    ttl: input.ttl ?? '3600s',
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  if (hasContents) {
    body.contents = input.contents!.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.text }],
    }));
  }

  const response = await fetchWithTimeout(cachedContentsEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as CachedContentObject;
}

export async function listCachedContents(): Promise<CachedContentObject[]> {
  assertApiKey();

  const response = await fetchWithTimeout(cachedContentsEndpoint(), { method: 'GET' });
  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const json = (await response.json()) as CachedContentListResponse;
  return json.cachedContents ?? [];
}

export async function deleteCachedContent(name: string): Promise<void> {
  assertApiKey();

  if (!name.startsWith('cachedContents/')) {
    throw new Error('Invalid cache name: expected "cachedContents/<id>".');
  }

  const response = await fetchWithTimeout(cachedContentsEndpoint(`/${encodeURIComponent(name.slice('cachedContents/'.length))}`), {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readError(response));
  }
}
