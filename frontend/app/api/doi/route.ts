import { NextResponse } from 'next/server'
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout'

type ReferenceInput  = { reference: string }
type DOIResult        = { reference: string; doi: string }
type APIRequestBody   = { references: ReferenceInput[] }
type GeminiResponse   = { response?: string }

export async function POST(request: Request): Promise<NextResponse> {
  let reqJson: APIRequestBody
  try {
    reqJson = await request.json()
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Invalid JSON body'
    return NextResponse.json(
      { error: msg, stage: 'parsing request body' },
      { status: 400 }
    )
  }

  const { references } = reqJson
  if (!Array.isArray(references)) {
    return NextResponse.json(
      { error: '`references` must be an array', stage: 'validation' },
      { status: 400 }
    )
  }

  const formattedList = references
    .map(r => `- "${r.reference}"`)
    .join('\n')

  const systemPrompt = `You are a helpful assistant. Given the following list of references, find the DOI for each.
If no DOI can be found, respond with the string "none".
Return your answer as JSONL: one JSON object per line, each with keys "reference" and "doi".\n\n${formattedList}`

  try {
    // FE-SSRF-002: derive the internal API origin from server config, never from
    // the request Host header — a spoofed Host would otherwise exfiltrate
    // SERVICE_API_KEY to an attacker-controlled origin.
    const baseUrl =
      process.env.INTERNAL_BASE_URL ??
      process.env.NEXTAUTH_URL ??
      'http://127.0.0.1:3000'

    const geminiRes = await fetchWithTimeout(`${baseUrl}/api/gemini`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.SERVICE_API_KEY ?? '',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', text: systemPrompt }],
        new_chat: false,
      }),
    })
    if (!geminiRes.ok) {
      const text = await geminiRes.text()
      return NextResponse.json(
        {
          error: `Gemini API returned ${geminiRes.status}`,
          details: text,
          stage: 'gemini call',
        },
        { status: 502 }
      )
    }

    const geminiJson = (await geminiRes.json()) as GeminiResponse
    const rawOutput  = geminiJson.response ?? ''
    const lines      = rawOutput.split('\n').map(l => l.trim()).filter(Boolean)

    const results: DOIResult[] = lines.map(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith('{')) {
        try {
          return JSON.parse(trimmed) as DOIResult
        } catch {
        }
      }
      const ref = trimmed.replace(/^[-\s"]+/, '').replace(/"$/, '')
      return { reference: ref, doi: 'none' }
    })

    return NextResponse.json({ results })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unexpected server error'
    return NextResponse.json(
      { error: msg, stage: 'unexpected' },
      { status: 500 }
    )
  }
}
