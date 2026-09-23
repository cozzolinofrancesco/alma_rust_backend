import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { DEFAULT_MODEL, isValidModel } from '../../../lib/modelConfig';
import { authorizeServiceRequest } from '../../../lib/serviceApiAuth';
import {
  createCachedContent,
  deleteCachedContent,
  listCachedContents,
} from '../../../lib/geminiCache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CreateCacheSchema = z
  .object({
    model: z
      .string()
      .default(DEFAULT_MODEL)
      .refine(isValidModel, { message: 'Unsupported model' }),
    systemInstruction: z.string().min(1).optional(),
    contents: z
      .array(
        z.object({
          role: z.enum(['user', 'model']),
          text: z.string().min(1),
        })
      )
      .optional(),
    ttl: z
      .string()
      .regex(/^\d+s$/, { message: 'ttl must look like "3600s"' })
      .optional(),
  })
  .strict()
  .refine((data) => Boolean(data.systemInstruction) || (data.contents?.length ?? 0) > 0, {
    message: 'Provide a systemInstruction and/or contents to cache.',
  });

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const auth = authorizeServiceRequest(request, (body as { api_key?: string })?.api_key);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const parsed = CreateCacheSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  }

  try {
    const cache = await createCachedContent(parsed.data);
    return NextResponse.json({
      name: cache.name,
      model: cache.model,
      expireTime: cache.expireTime,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create cache';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  const auth = authorizeServiceRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const caches = await listCachedContents();
    return NextResponse.json({ caches });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list caches';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = authorizeServiceRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const name = request.nextUrl.searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'Query parameter "name" is required (cachedContents/<id>).' }, { status: 400 });
  }

  try {
    await deleteCachedContent(name);
    return NextResponse.json({ deleted: true, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete cache';
    const status = message.startsWith('Invalid cache name') ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
