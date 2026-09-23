import { CrossRefMetadata, CrossRefSearchResult } from '../types';

const RATE_LIMIT_DELAY = 100;


const API_BASE_URL = '/api/crossref';

export async function searchCrossRef(
    title: string,
    authors?: string[],
    year?: string
): Promise<CrossRefSearchResult[]> {
    try {
        console.log('🔍 CrossRef Search via API route:', { title, authors, year });

        const params = new URLSearchParams({
            action: 'search',
            title: title
        });

        if (authors && authors.length > 0) {
            params.append('authors', authors.join(', '));
        }

        if (year) {
            params.append('year', year);
        }

        const response = await fetch(`${API_BASE_URL}?${params.toString()}`);

        if (!response.ok) {
            console.warn(`⚠️ CrossRef Search API error ${response.status} for title: ${title}`);
            return [];
        }

        const results = await response.json();

        console.log('✅ CrossRef Search Results:', results.length, 'matches found');
        return results;

    } catch (error) {
        console.error('❌ CrossRef search error:', error);
        return [];
    }
}

export async function getCrossRefMetadata(doi: string): Promise<CrossRefMetadata | null> {
    try {
        console.log('📖 CrossRef Metadata Lookup via API route:', doi);

        const params = new URLSearchParams({
            action: 'metadata',
            doi: doi
        });

        const response = await fetch(`${API_BASE_URL}?${params.toString()}`);

        if (!response.ok) {
            console.warn(`⚠️ CrossRef API error ${response.status} for DOI: ${doi}`);
            return {
                doi,
                title: 'Unknown Title',
                authors: [],
                journal: 'Unknown Journal',
                publishedDate: 'Unknown Date',
                citationCount: 0,
                isOpenAccess: false,
                publisher: 'Unknown Publisher',
                verificationStatus: 'error',
                lastChecked: new Date().toISOString()
            };
        }

        const metadata = await response.json();

        if (metadata) {
            console.log('✅ CrossRef Metadata Found:', metadata.title);
            return metadata;
        }

        return null;

    } catch (error) {
        console.error('❌ CrossRef metadata error:', error);
        return {
            doi,
            title: 'Unknown Title',
            authors: [],
            journal: 'Unknown Journal',
            publishedDate: 'Unknown Date',
            citationCount: 0,
            isOpenAccess: false,
            publisher: 'Unknown Publisher',
            verificationStatus: 'error',
            lastChecked: new Date().toISOString()
        };
    }
}

export interface CrossRefLookup {
    metadata: typeof getCrossRefMetadata;
    search: typeof searchCrossRef;
    signal?: AbortSignal;
}

export async function enrichReferencesWithCrossRef(
    references: Array<{
        id: string;
        label: string;
        extractedTitle?: string;
        extractedAuthors?: string[];
        extractedYear?: string;
        extractedDOI?: string;
    }>,
    lookup: CrossRefLookup = { metadata: getCrossRefMetadata, search: searchCrossRef }
): Promise<Array<{
    id: string;
    label: string;
    crossRefData?: CrossRefMetadata;
    enhancedCredibilityScore: number;
}>> {
    console.log('🔄 Enriching', references.length, 'references with CrossRef data via API route');
    const enrichedReferences = [];

    for (const ref of references) {
        lookup.signal?.throwIfAborted();
        await delay(RATE_LIMIT_DELAY);

        let crossRefData: CrossRefMetadata | null = null;

        if (ref.extractedDOI) {
            console.log('🔍 Looking up DOI:', ref.extractedDOI);
            crossRefData = await lookup.metadata(ref.extractedDOI);
        }

        if (!crossRefData || crossRefData.verificationStatus === 'error') {
            console.log('🔍 Searching by title:', ref.extractedTitle || ref.label);
            const searchResults = await lookup.search(
                ref.extractedTitle || ref.label,
                ref.extractedAuthors,
                ref.extractedYear
            );

            if (searchResults.length > 0) {
                const bestMatch = searchResults[0];
                crossRefData = await lookup.metadata(bestMatch.doi);
            }
        }

        const enhancedCredibilityScore = calculateEnhancedCredibilityScore(
            ref.label,
            crossRefData || undefined
        );

        enrichedReferences.push({
            id: ref.id,
            label: ref.label,
            crossRefData: crossRefData || undefined,
            enhancedCredibilityScore
        });

        console.log('✅ Enriched reference:', ref.id, 'Score:', enhancedCredibilityScore);
    }

    console.log('🎉 CrossRef enrichment complete!', enrichedReferences.length, 'references processed');
    return enrichedReferences;
}

function calculateEnhancedCredibilityScore(
    originalLabel: string,
    crossRefData?: CrossRefMetadata
): number {
    let score = 0.3;

    if (!crossRefData || crossRefData.verificationStatus !== 'verified') {
        return score;
    }

    score += 0.2;

    const citationCount = crossRefData.citationCount;
    if (citationCount > 0) {
        score += Math.min(0.3, Math.log10(citationCount + 1) * 0.1);
    }

    const publishYear = new Date(crossRefData.publishedDate).getFullYear();
    const currentYear = new Date().getFullYear();
    const yearsSincePublication = currentYear - publishYear;
    if (yearsSincePublication <= 5) {
        score += 0.1;
    }

    if (crossRefData.isOpenAccess) {
        score += 0.05;
    }

    const journal = crossRefData.journal.toLowerCase();
    if (journal.includes('nature') || journal.includes('science') ||
        journal.includes('cell') || journal.includes('lancet')) {
        score += 0.1;
    }

    return Math.min(1.0, score);
}




function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function extractReferenceInfo(citationText: string): {
    title?: string;
    authors?: string[];
    year?: string;
    doi?: string;
} {
    const result: {
        title?: string;
        authors?: string[];
        year?: string;
        doi?: string;
    } = {};

    const doiMatch = citationText.match(/(?:doi:|DOI:)\s*([^\s,]+)/i);
    if (doiMatch) {
        result.doi = doiMatch[1];
    }

    const yearMatch = citationText.match(/\((\d{4})\)|(\d{4})/);
    if (yearMatch) {
        result.year = yearMatch[1] || yearMatch[2];
    }

    const authorMatch = citationText.match(/^([^(]+?)(?:\s*\(\d{4}\)|$)/);
    if (authorMatch) {
        const authorText = authorMatch[1].trim();
        const authors = authorText
            .split(/[,&]|and\s+/)
            .map(author => author.trim())
            .filter(author => author.length > 2 && !author.includes('et al'))
            .slice(0, 3);

        if (authors.length > 0) {
            result.authors = authors;
        }
    }

    const titleMatch = citationText.match(/"([^"]+)"|'([^']+)'/) ||
        citationText.match(/\.\s*([^.]+)\.\s*[A-Z]/);
    if (titleMatch) {
        result.title = (titleMatch[1] || titleMatch[2] || titleMatch[3])?.trim();
    }

    return result;
} 