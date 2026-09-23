import { DEFAULT_API_TIMEOUT_MS } from './modelConfig';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const { signal } = controller;

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal });
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      const host = (() => {
        try { return new URL(url).host; } catch { return url.slice(0, 60); }
      })();
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s: ${host}`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
