import { NextRequest, NextResponse } from 'next/server';

const CROSSREF_BASE_URL = 'https://api.crossref.org';
const USER_AGENT = 'ProofValidationFlow/1.0 (mailto:contact@example.com)';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    try {
        if (action === 'search') {
            const title = searchParams.get('title');
            const authors = searchParams.get('authors');
            const year = searchParams.get('year');

            if (!title) {
                return NextResponse.json({ error: 'Title is required' }, { status: 400 });
            }

            const cleanTitle = title.replace(/[^\w\s]/g, ' ').trim();
            let query = `title:"${cleanTitle}"`;

            if (authors) {
                const authorQuery = authors.replace(/[^\w\s]/g, ' ').trim();
                query += ` author:"${authorQuery}"`;
            }

            if (year) {
                query += ` published:${year}`;
            }

            const searchUrl = `${CROSSREF_BASE_URL}/works?query=${encodeURIComponent(query)}&rows=5&sort=relevance&order=desc`;

            const response = await fetch(searchUrl, {
                signal: request.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                console.warn(`CrossRef API error ${response.status} for search: ${query}`);
                return NextResponse.json([]);
            }

            const data = await response.json();

            if (!data.message?.items) {
                return NextResponse.json([]);
            }

            const results = data.message.items.map((item: CrossRefItem) => ({
                doi: item.DOI,
                score: item.score || 0,
                title: item.title?.[0] || 'Unknown Title',
                authors: extractAuthors(item.author || []),
                journal: item['container-title']?.[0] || 'Unknown Journal',
                publishedDate: formatDate(item.published),
                citationCount: item['is-referenced-by-count'] || 0,
                isOpenAccess: item['is-oa'] || false
            }));

            return NextResponse.json(results);

        } else if (action === 'metadata') {
            const doi = searchParams.get('doi');

            if (!doi) {
                return NextResponse.json({ error: 'DOI is required' }, { status: 400 });
            }

            const url = `${CROSSREF_BASE_URL}/works/${encodeURIComponent(doi)}`;
            const response = await fetch(url, {
                signal: request.signal,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                console.warn(`CrossRef API error ${response.status} for DOI: ${doi}`);
                return NextResponse.json(null);
            }

            const data = await response.json();

            if (!data.message) {
                return NextResponse.json(null);
            }

            const item = data.message;
            const metadata = {
                doi: item.DOI,
                title: item.title?.[0] || 'Unknown Title',
                authors: extractAuthors(item.author || []),
                journal: item['container-title']?.[0] || 'Unknown Journal',
                publishedDate: formatDate(item.published),
                citationCount: item['is-referenced-by-count'] || 0,
                isOpenAccess: item['is-oa'] || false,
                publisher: item.publisher || 'Unknown Publisher',
                issn: item.ISSN?.[0],
                volume: item.volume,
                issue: item.issue,
                pages: item.page,
                url: item.URL,
                verificationStatus: 'verified',
                lastChecked: new Date().toISOString()
            };

            return NextResponse.json(metadata);

        } else {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

    } catch (error) {
        console.error('CrossRef API route error:', error);
        return NextResponse.json(
            { error: 'Failed to fetch from CrossRef API' },
            { status: 500 }
        );
    }
}

interface CrossRefAuthor {
    given?: string;
    family?: string;
    name?: string;
}

interface CrossRefItem {
    DOI: string;
    score?: number;
    title?: string[];
    author?: CrossRefAuthor[];
    'container-title'?: string[];
    published?: {
        'date-parts': number[][];
    };
    'is-referenced-by-count'?: number;
    'is-oa'?: boolean;
    publisher?: string;
    ISSN?: string[];
    volume?: string;
    issue?: string;
    page?: string;
    URL?: string;
}

function extractAuthors(authors: CrossRefAuthor[]): string[] {
    return authors.map(author => {
        if (author.given && author.family) {
            return `${author.family}, ${author.given}`;
        } else if (author.name) {
            return author.name;
        } else {
            return 'Unknown Author';
        }
    });
}

function formatDate(dateObj?: { 'date-parts': number[][] }): string {
    if (!dateObj || !dateObj['date-parts'] || !dateObj['date-parts'][0]) {
        return 'Unknown Date';
    }

    const dateParts = dateObj['date-parts'][0];
    const year = dateParts[0];
    const month = dateParts[1] || 1;
    const day = dateParts[2] || 1;

    return new Date(year, month - 1, day).toISOString().split('T')[0];
} 