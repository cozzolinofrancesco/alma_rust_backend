import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_MODEL } from '../../lib/modelConfig';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const SERVICE_API_KEY = process.env.SERVICE_API_KEY;

const DEFAULT_PROMPT = `Perform a systematic scientific analysis of this image. Provide:
1. OBJECT IDENTIFICATION: Precisely identify and classify all visible objects, structures, and entities
2. QUANTITATIVE OBSERVATIONS: Describe measurable aspects (sizes, quantities, spatial relationships)
3. TECHNICAL DETAILS: Identify any scientific instruments, equipment, diagrams, or technical elements
4. TEXT EXTRACTION: Transcribe all visible text, labels, numbers, and annotations exactly as shown
5. VISUAL DATA: Describe colors, patterns, textures, and any data visualizations present
6. CONTEXTUAL ANALYSIS: Determine the likely scientific domain, purpose, or application
7. ANOMALIES/NOTABLE FEATURES: Highlight any unusual, significant, or scientifically relevant details

Provide factual, precise observations without speculation. Use scientific terminology when appropriate.`;

const DEFAULT_GENERATION_CONFIG = {
  temperature: 0.1,
  topP: 0.95,
  topK: 20,
  candidateCount: 1,
  maxOutputTokens: 65535,
};

interface GeminiGenerateResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
    safetyRatings?: unknown[];
  }[];
}

function inferMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
  };
  return mimeTypes[ext || ''] || 'image/jpeg';
}

async function parseFormData(request: NextRequest): Promise<FormData> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    throw new Error('Request must be multipart/form-data');
  }
  return await request.formData();
}

export async function POST(request: NextRequest) {
  console.log('📨 [Image Analysis API] Incoming request');

  try {
    if (!GEMINI_API_KEY) {
      console.error('❌ [Image Analysis API] GEMINI_API_KEY not configured');
      return NextResponse.json(
        { error: 'Server configuration error: Gemini API key not configured' },
        { status: 500 }
      );
    }

    const contentType = request.headers.get('content-type') || '';
    console.log('📨 Content-Type:', contentType);

    let userApiKey: string;
    let prompt: string = DEFAULT_PROMPT;
    let model: string = DEFAULT_MODEL;
    const imageFiles: File[] = [];

    if (contentType.includes('multipart/form-data')) {
      console.log('🗂️ [Image Analysis API] Processing multipart form data...');

      const formData = await parseFormData(request);
      console.log('🗂️ Form data fields:', Array.from(formData.keys()));

      userApiKey = formData.get('api_key') as string;
      if (!userApiKey) {
        return NextResponse.json(
          { error: 'API key is required to access this service.' },
          { status: 401 }
        );
      }

      if (!SERVICE_API_KEY || userApiKey !== SERVICE_API_KEY) {
        console.log('❌ [Image Analysis API] Invalid service API key provided or SERVICE_API_KEY not configured');
        return NextResponse.json(
          { error: 'Invalid API key.' },
          { status: 401 }
        );
      }

      const formPrompt = formData.get('prompt') as string;
      if (formPrompt && formPrompt.trim()) {
        prompt = formPrompt.trim();
        console.log('✍️ [Image Analysis API] Using custom prompt');
      } else {
        console.log('✍️ [Image Analysis API] Using default prompt');
      }

      const formModel = formData.get('model') as string;
      if (formModel && formModel.trim()) {
        model = formModel.trim();
      }

      for (const [, value] of formData.entries()) {
        if (value instanceof File && value.type.startsWith('image/')) {
          imageFiles.push(value);
          console.log(`🖼️ [Image Analysis API] Found image: ${value.name} (${value.type})`);
        }
      }

      if (imageFiles.length === 0) {
        return NextResponse.json(
          { error: 'No image files provided. Please upload at least one image.' },
          { status: 400 }
        );
      }

    } else {
      console.log('🗒️ [Image Analysis API] Processing JSON request...');

      try {
        const body = await request.json();

        userApiKey = body.api_key || request.headers.get('x-api-key') || '';
        if (!userApiKey) {
          return NextResponse.json(
            { error: 'API key is required to access this service. Provide it in the request body or X-API-Key header.' },
            { status: 401 }
          );
        }

        if (!SERVICE_API_KEY || userApiKey !== SERVICE_API_KEY) {
          console.log('❌ [Image Analysis API] Invalid service API key provided or SERVICE_API_KEY not configured');
          return NextResponse.json(
            { error: 'Invalid API key.' },
            { status: 401 }
          );
        }

        if (body.prompt && body.prompt.trim()) {
          prompt = body.prompt.trim();
          console.log('✍️ [Image Analysis API] Using custom prompt');
        } else {
          console.log('✍️ [Image Analysis API] Using default prompt');
        }

        if (body.model && body.model.trim()) {
          model = body.model.trim();
        }

        if (body.images && Array.isArray(body.images)) {
          for (const imageData of body.images) {
            if (imageData.data && imageData.mimeType) {
              const buffer = Buffer.from(imageData.data, 'base64');
              const file = new File([buffer], imageData.filename || 'image.jpg', {
                type: imageData.mimeType
              });
              imageFiles.push(file);
              console.log(`🖼️ [Image Analysis API] Found base64 image: ${imageData.filename || 'unnamed'} (${imageData.mimeType})`);
            }
          }
        }

        if (imageFiles.length === 0) {
          return NextResponse.json(
            { error: 'No images provided. Please include base64 encoded images in the request.' },
            { status: 400 }
          );
        }

      } catch {
        return NextResponse.json(
          { error: 'Invalid JSON in request body.' },
          { status: 400 }
        );
      }
    }

    console.log('✅ [Image Analysis API] Service API key validated successfully');

    console.log(`🤖 [Image Analysis API] Using model: ${model}`);
    console.log(`📷 [Image Analysis API] Processing ${imageFiles.length} image(s)`);

    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

    parts.push({ text: prompt });

    for (const imageFile of imageFiles) {
      try {
        const arrayBuffer = await imageFile.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Data = buffer.toString('base64');
        const mimeType = imageFile.type || inferMimeType(imageFile.name);

        parts.push({
          inlineData: {
            mimeType,
            data: base64Data
          }
        });

        console.log(`📎 [Image Analysis API] Prepared image: ${imageFile.name} (${mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
      } catch (fileError) {
        console.error('❌ [Image Analysis API] Error processing image:', fileError);
        return NextResponse.json(
          { error: `Failed to process image: ${imageFile.name}` },
          { status: 400 }
        );
      }
    }

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts
        }
      ],
      generationConfig: DEFAULT_GENERATION_CONFIG
    };

    const endpoint = `${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    console.log('🌐 [Image Analysis API] Making request to Gemini API...');
    console.log(`🔗 [Image Analysis API] Endpoint: ${GEMINI_BASE_URL}/v1beta/models/${model}:generateContent`);

    const startTime = Date.now();
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const requestDuration = Date.now() - startTime;
    console.log(`📡 [Image Analysis API] API response received in ${requestDuration}ms`);
    console.log(`🔍 [Image Analysis API] Response status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ [Image Analysis API] Gemini API error:', errorText);

      if (response.status === 401) {
        return NextResponse.json(
          { error: 'Server authentication error with Gemini API.' },
          { status: 500 }
        );
      } else if (response.status === 429) {
        return NextResponse.json(
          { error: 'Rate limit exceeded. Please try again later.' },
          { status: 429 }
        );
      } else {
        return NextResponse.json(
          { error: `Gemini API error: ${response.status} ${response.statusText}` },
          { status: response.status }
        );
      }
    }

    const data = (await response.json()) as GeminiGenerateResponse;

    console.log('📊 [Image Analysis API] Response data structure:', {
      hasCandidates: !!data.candidates,
      candidatesLength: data.candidates?.length || 0,
      hasContent: !!data.candidates?.[0]?.content,
      hasText: !!data.candidates?.[0]?.content?.parts?.[0]?.text
    });

    const result = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!result) {
      console.error('❌ [Image Analysis API] No text content in response');
      console.error('Full response:', JSON.stringify(data, null, 2));

      const candidate = data.candidates?.[0];
      if (candidate?.finishReason) {
        console.error('Finish reason:', candidate.finishReason);
        if (candidate.finishReason === 'SAFETY') {
          return NextResponse.json(
            { error: 'Content was blocked due to safety policies.' },
            { status: 400 }
          );
        }
      }

      return NextResponse.json(
        { error: 'No analysis result received from Gemini.' },
        { status: 500 }
      );
    }

    console.log(`✅ [Image Analysis API] Analysis completed successfully (${result.length} characters)`);

    return NextResponse.json({
      success: true,
      analysis: result,
      metadata: {
        model: model,
        imageCount: imageFiles.length,
        promptUsed: prompt === DEFAULT_PROMPT ? 'default' : 'custom',
        processingTime: requestDuration,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ [Image Analysis API] Unexpected error:', error);

    return NextResponse.json(
      {
        error: 'An unexpected error occurred while processing your request.',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  const documentation = {
    title: "Image Analysis API Documentation",
    description: "AI-powered image analysis using Google Gemini models for scientific and general image understanding",
    version: "1.0.0",
    features: [
      "Multimodal image analysis with Gemini 2.5 Pro",
      "Scientific analysis with detailed object identification",
      "Text extraction from images with formatting preservation",
      "Custom prompt support for specialized analysis",
      "Support for multiple image formats (JPG, PNG, WebP, GIF)",
      "Comprehensive metadata and performance metrics",
      "Form data and JSON request support"
    ],
    supported_formats: {
      "JPG/JPEG": "Joint Photographic Experts Group",
      "PNG": "Portable Network Graphics",
      "WebP": "Web Picture format",
      "GIF": "Graphics Interchange Format"
    },
    endpoints: {
      "POST /api/image-analysis": {
        description: "Analyze images using AI",
        content_types: ["multipart/form-data", "application/json"],
        parameters: {
          "api_key": "Required. Your service API key for authentication",
          "image": "Required. Image file to analyze (multipart/form-data)",
          "images": "Required. Array of base64 encoded images (JSON)",
          "prompt": "Optional. Custom analysis prompt (defaults to scientific analysis)",
          "model": "Optional. Gemini model to use (defaults to gemini-3.1-pro-preview)"
        },
        response: "JSON with analysis results and metadata"
      },
      "GET /api/image-analysis": {
        description: "Get API documentation and download links",
        response: "JSON documentation"
      }
    },
    download_links: {
      "test-image-analysis.sh": {
        description: "Bash script for testing the Image Analysis API",
        features: [
          "Interactive image format validation",
          "Custom prompt support",
          "Organized output folder creation",
          "Real-time processing with timing metrics",
          "Comprehensive error handling",
          "Performance metrics and summary reporting"
        ],
        usage: [
          "./test-image-analysis.sh sample.jpg",
          "./test-image-analysis.sh chart.png analysis_results",
          "./test-image-analysis.sh diagram.png results \"Extract all text and data from this diagram\""
        ],
        download_url: "/api/image-analysis/test-image-analysis.sh"
      }
    },
    examples: {
      "curl_example": {
        description: "Direct API call with curl",
        command: `curl -X POST http://localhost:8080/api/image-analysis \\
  -H "Content-Type: multipart/form-data" \\
  -F "api_key=YOUR_API_KEY_HERE" \\
  -F "image=@sample.jpg" \\
  -F "prompt=What do you see in this image? Provide a detailed scientific analysis."`,
        warning: "⚠️  IMPORTANT: Replace 'localhost:8080' with your actual server URL when deploying to production!"
      },
      "bash_script_example": {
        description: "Using the provided test script",
        command: "./test-image-analysis.sh sample.jpg analysis_results",
        warning: "⚠️  IMPORTANT: Update the PORT variable in the script to match your server URL when deploying to production!"
      }
    },
    response_format: {
      success: true,
      analysis: "Detailed analysis text from Gemini model",
      metadata: {
        model: "gemini-2.5-pro",
        imageCount: 1,
        promptUsed: "default or custom",
        processingTime: 2450,
        timestamp: "2024-01-01T12:00:00.000Z"
      }
    },
    requirements: {
      "server": [
        "Node.js 18+",
        "Next.js 13+",
        "GEMINI_API_KEY environment variable",
        "SERVICE_API_KEY environment variable (required)"
      ],
      "client": [
        "curl (for direct API calls)",
        "bash (for test script)"
      ]
    },
    deployment_warnings: {
      "localhost_replacement": "⚠️  IMPORTANT: All examples use 'localhost:8080' for development. Replace with your actual server URL when deploying to production!",
      "api_key_security": "⚠️  IMPORTANT: Set the SERVICE_API_KEY environment variable to a secure value in production!",
      "script_configuration": "⚠️  IMPORTANT: Update the PORT variable in test scripts to match your server configuration!"
    }
  };

  return new Response(JSON.stringify(documentation, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age': '86400',
    },
  });
} 