const documentEtags = new WeakMap<object, string>();

export function rememberAgentEtag<Value>(document: Value, etag?: string | null): Value {
  if (document && typeof document === 'object' && etag) documentEtags.set(document, etag);
  return document;
}

export function getAgentEtag(document: unknown): string | undefined {
  return document && typeof document === 'object' ? documentEtags.get(document) : undefined;
}

export function inheritAgentEtag<Value>(source: unknown, next: Value): Value {
  return rememberAgentEtag(next, getAgentEtag(source));
}