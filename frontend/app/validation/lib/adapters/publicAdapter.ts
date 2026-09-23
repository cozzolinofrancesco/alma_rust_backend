import type { Claim, RetrievalResult } from '@/app/claim-validation/types';
import { fetchWithTimeout } from '@/app/lib/fetchWithTimeout';
import { buildRetrieval, type ReferenceAdapter } from '../referenceAdapter';

// doc-public: evidence = top abstracts/titles for the claim from the public
// scholarly record (OpenAlex for abstracts, CrossRef + PubMed for titles).
// LIMITATION: titles + abstracts only — no full text — so this verifies
// alignment with the public record's abstracts, not full-text proof.

const TIMEOUT = 15_000;
const PER_SOURCE = 3;
const UA = 'ALMA-Validation/1.0 (mailto:research@example.com)';

interface PublicHit {
  title: string;
  abstract?: string;
  doi?: string;
  url?: string;
  source: 'openalex' | 'crossref' | 'pubmed';
}

function reconstructAbstract(inverted?: Record<string, number[]>): string | undefined {
  if (!inverted) return undefined;
  const positions: Array<{ word: string; pos: number }> = [];
  for (const [word, locs] of Object.entries(inverted)) {
    for (const pos of locs) positions.push({ word, pos });
  }
  if (positions.length === 0) return undefined;
  return positions.sort((a, b) => a.pos - b.pos).map((p) => p.word).join(' ').slice(0, 1200);
}

async function searchOpenAlex(query: string): Promise<PublicHit[]> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${PER_SOURCE}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, TIMEOUT);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{ title?: string; doi?: string; abstract_inverted_index?: Record<string, number[]> }>;
    };
    return (data.results ?? []).map((w) => ({
      title: w.title ?? '(untitled)',
      abstract: reconstructAbstract(w.abstract_inverted_index),
      doi: w.doi ?? undefined,
      url: w.doi ?? undefined,
      source: 'openalex' as const,
    }));
  } catch { return []; }
}

async function searchCrossRef(query: string): Promise<PublicHit[]> {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${PER_SOURCE}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, TIMEOUT);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      message?: { items?: Array<{ title?: string[]; DOI?: string; abstract?: string }> };
    };
    return (data.message?.items ?? []).map((it) => ({
      title: it.title?.[0] ?? '(untitled)',
      abstract: it.abstract ? it.abstract.replace(/<[^>]+>/g, '').slice(0, 1200) : undefined,
      doi: it.DOI,
      url: it.DOI ? `https://doi.org/${it.DOI}` : undefined,
      source: 'crossref' as const,
    }));
  } catch { return []; }
}

async function searchPubMed(query: string): Promise<PublicHit[]> {
  try {
    const apiKey = process.env.PUBMED_API_KEY ? `&api_key=${process.env.PUBMED_API_KEY}` : '';
    const esearch = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${PER_SOURCE}&term=${encodeURIComponent(query)}${apiKey}`;
    const sres = await fetchWithTimeout(esearch, {}, TIMEOUT);
    if (!sres.ok) return [];
    const sdata = (await sres.json()) as { esearchresult?: { idlist?: string[] } };
    const ids = sdata.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];
    const esummary = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${apiKey}`;
    const sumRes = await fetchWithTimeout(esummary, {}, TIMEOUT);
    if (!sumRes.ok) return [];
    const sumData = (await sumRes.json()) as { result?: Record<string, { uid?: string; title?: string }> };
    const result = sumData.result ?? {};
    return ids
      .map((id) => result[id])
      .filter((r): r is { uid?: string; title?: string } => Boolean(r))
      .map((r) => ({
        title: r.title ?? '(untitled)',
        url: r.uid ? `https://pubmed.ncbi.nlm.nih.gov/${r.uid}/` : undefined,
        source: 'pubmed' as const,
      }));
  } catch { return []; }
}

function dedupe(hits: PublicHit[]): PublicHit[] {
  const seen = new Set<string>();
  const out: PublicHit[] = [];
  for (const h of hits) {
    const key = (h.doi ?? h.title).toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function createPublicAdapter(): ReferenceAdapter {
  return {
    mode: 'doc-public',
    label: 'Document vs public record',
    async getEvidence(claim: Claim): Promise<RetrievalResult> {
      const query = (claim.claim_summary?.trim() || claim.claim_text).slice(0, 300);
      const [openalex, crossref, pubmed] = await Promise.all([
        searchOpenAlex(query),
        searchCrossRef(query),
        searchPubMed(query),
      ]);
      const hits = dedupe([...openalex, ...crossref, ...pubmed]).slice(0, 5);
      const chunks = hits.map((h) => ({
        content: `${h.title}${h.abstract ? `\n${h.abstract}` : ''}`,
        source_ref: h.url ?? `${h.source}:${h.title}`,
      }));
      return buildRetrieval(claim.claim_id, 'public', chunks);
    },
  };
}
