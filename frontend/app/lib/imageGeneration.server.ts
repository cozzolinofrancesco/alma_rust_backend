import { GoogleGenAI } from '@google/genai';
import { IMAGE_GENERATION_MODELS } from './modelConfig';

export async function generateImageContent(
  prompt: string,
  model: string,
  image?: { mimeType: string; data: string },
  signal?: AbortSignal,
  options?: { singleAttempt?: boolean; maxTokens?: number; temperature?: number },
) {
  if (!prompt.trim() || !Object.prototype.hasOwnProperty.call(IMAGE_GENERATION_MODELS, model)) throw new Error('Invalid image generation request.');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY,
    ...(options?.singleAttempt ? { httpOptions: { retryOptions: { attempts: 1 } } } : {}) });
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt.trim() }];
  if (image) parts.push({ inlineData: image });
  const response = await ai.models.generateContent({
    model,
    contents: image ? [{ role: 'user', parts }] : prompt.trim(),
    ...((signal || options?.maxTokens || options?.temperature !== undefined) ? { config: {
      ...(signal ? { abortSignal: signal } : {}),
      ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    } } : {}),
  });
  const images: Array<{ mimeType: string; data: string }> = [];
  const text: string[] = [];
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text) text.push(part.text);
      else if (part.inlineData?.data && part.inlineData.mimeType) images.push({ mimeType: part.inlineData.mimeType, data: part.inlineData.data });
    }
  }
  return { images, ...(text.length ? { text: text.join('\n') } : {}), model };
}