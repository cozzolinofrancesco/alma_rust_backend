import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/app/lib/authOptions';
import { authorizeServiceRequest } from '@/app/lib/serviceApiAuth';
import { IMAGE_GENERATION_MODELS, DEFAULT_IMAGE_MODEL } from '@/app/lib/modelConfig';
import { generateImageContent } from '@/app/lib/imageGeneration.server';

type ImageModel = keyof typeof IMAGE_GENERATION_MODELS;

interface GenerateImageRequest {
  prompt: string;
  model?: ImageModel;
  imageData?: string;
  imageMimeType?: string;
  api_key?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await getServerSession(authOptions);

  let body: GenerateImageRequest;

  try {
    body = (await request.json()) as GenerateImageRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!session) {
    const serviceAuth = authorizeServiceRequest(request, body.api_key);
    if (!serviceAuth.ok) {
      return NextResponse.json({ error: serviceAuth.error }, { status: serviceAuth.status });
    }
  }

  const { prompt, model = DEFAULT_IMAGE_MODEL, imageData, imageMimeType } = body;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return NextResponse.json({ error: 'A non-empty "prompt" string is required.' }, { status: 400 });
  }

  if (!Object.keys(IMAGE_GENERATION_MODELS).includes(model)) {
    return NextResponse.json(
      { error: `Unsupported model "${model}". Valid options: ${Object.keys(IMAGE_GENERATION_MODELS).join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const result = await generateImageContent(prompt, model,
      imageData && imageMimeType ? { mimeType: imageMimeType, data: imageData } : undefined, request.signal);
    if (result.images.length === 0 && !result.text) {
      return NextResponse.json(
        { error: 'The model returned no images or text. Try rephrasing your prompt.' },
        { status: 502 }
      );
    }
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('429') || message.toLowerCase().includes('quota')) {
      return NextResponse.json(
        { error: 'API quota exhausted. Please try again later.', errorType: 'QUOTA_EXHAUSTED' },
        { status: 429 }
      );
    }

    if (message.includes('SAFETY') || message.toLowerCase().includes('blocked')) {
      return NextResponse.json(
        { error: 'The prompt was blocked by safety filters. Please revise it.', errorType: 'SAFETY_BLOCKED' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: message, errorType: 'GENERATION_ERROR' },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    models: Object.entries(IMAGE_GENERATION_MODELS).map(([id, description]) => ({
      id,
      description,
    })),
    defaultModel: DEFAULT_IMAGE_MODEL,
  });
}
