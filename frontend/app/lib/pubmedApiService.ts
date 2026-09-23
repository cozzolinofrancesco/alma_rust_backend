export interface ScientificPaper {
    title: string;
    pubdate: string;
    authors: string[];
    doi: string;
    abstract: string;
    pubMedLink?: string;
}

export interface SelectedPaper {
    id: string;
    title: string;
    abstract: string;
    authors: string[];
    pubdate: string;
    doi: string;
}

export enum PubMedErrorType {
    RATE_LIMIT = 'RATE_LIMIT',
    SERVER_ERROR = 'SERVER_ERROR',
    NETWORK_ERROR = 'NETWORK_ERROR',
    NOT_FOUND = 'NOT_FOUND',
    INVALID_QUERY = 'INVALID_QUERY',
    UNKNOWN = 'UNKNOWN'
}

export class PubMedApiError extends Error {
    constructor(
        public type: PubMedErrorType,
        public message: string,
        public statusCode?: number,
        public retryAfter?: number
    ) {
        super(message);
        this.name = 'PubMedApiError';
    }
}

interface ApiResponse {
    results: ScientificPaper[];
    totalCount: number;
}

interface RequestQueueItem {
    url: string;
    resolve: (value: ApiResponse) => void;
    reject: (error: PubMedApiError) => void;
    retryCount: number;
}

interface CacheEntry {
    results: ScientificPaper[];
    timestamp: number;
    totalCount?: number;
}

interface SearchResult {
    results: ScientificPaper[];
    totalCount: number;
    hasMore: boolean;
}

class PubMedApiService {
    private requestQueue: RequestQueueItem[] = [];
    private isProcessingQueue = false;
    private lastRequestTime = 0;
    private readonly MIN_REQUEST_INTERVAL = 350;
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAYS = [1000, 2000, 4000];

    private cache = new Map<string, CacheEntry>();
    private readonly CACHE_DURATION = 5 * 60 * 1000;
    private readonly MAX_CACHE_SIZE = 50;

    async searchPapers(query: string, limit: number = 25): Promise<ScientificPaper[]> {
        const result = await this.searchPapersWithPagination(query, 0, limit);
        return result.results;
    }

    async searchPapersWithPagination(query: string, offset: number = 0, limit: number = 25): Promise<SearchResult> {
        if (!query.trim()) {
            return { results: [], totalCount: 0, hasMore: false };
        }

        const cacheKey = `${query.trim().toLowerCase()}:${offset}:${limit}`;

        const cached = this.getFromCache(cacheKey);
        if (cached) {
            return {
                results: cached.results,
                totalCount: cached.totalCount || 0,
                hasMore: cached.results.length === limit
            };
        }

        try {
            const isDOI = query.includes('10.') || query.toLowerCase().startsWith('doi');
            const endpoint = isDOI ? 'doi' : 'fullsearch';
            const param = isDOI ? 'doi' : 'title';

            const url = `/api/pubmed/${endpoint}?${param}=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;

            const response = await this.queueRequest(url);
            const results = response.results || [];
            const totalCount = response.totalCount || results.length;

            this.setCache(cacheKey, {
                results,
                timestamp: Date.now(),
                totalCount
            });

            return {
                results,
                totalCount,
                hasMore: results.length === limit && (offset + limit) < totalCount
            };
        } catch (error) {
            if (error instanceof PubMedApiError) {
                throw error;
            }
            throw new PubMedApiError(
                PubMedErrorType.UNKNOWN,
                `Unexpected error during search: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    private async queueRequest(url: string): Promise<ApiResponse> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                url,
                resolve,
                reject,
                retryCount: 0
            });

            if (!this.isProcessingQueue) {
                this.processQueue();
            }
        });
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const item = this.requestQueue.shift()!;

            try {
                const timeSinceLastRequest = Date.now() - this.lastRequestTime;
                if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
                    await this.delay(this.MIN_REQUEST_INTERVAL - timeSinceLastRequest);
                }

                const result = await this.makeRequest(item.url);
                this.lastRequestTime = Date.now();
                item.resolve(result);
            } catch (error) {
                if (error instanceof PubMedApiError && this.shouldRetry(error, item.retryCount)) {
                    item.retryCount++;
                    const delay = this.RETRY_DELAYS[Math.min(item.retryCount - 1, this.RETRY_DELAYS.length - 1)];

                    console.warn(`PubMed API request failed, retrying in ${delay}ms (attempt ${item.retryCount}/${this.MAX_RETRIES}):`, error.message);

                    setTimeout(() => {
                        this.requestQueue.unshift(item);
                        if (!this.isProcessingQueue) {
                            this.processQueue();
                        }
                    }, delay);
                } else {
                    item.reject(error instanceof PubMedApiError ? error : new PubMedApiError(
                        PubMedErrorType.UNKNOWN,
                        error instanceof Error ? error.message : 'Unknown error'
                    ));
                }
            }
        }

        this.isProcessingQueue = false;
    }

    private async makeRequest(url: string): Promise<ApiResponse> {
        console.log(`📡 | Making request to: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            const errorType = this.categorizeError(response.status);
            const errorMessage = this.getErrorMessage(response.status, errorType);

            const retryAfter = response.headers.get('retry-after');
            const retryAfterMs = retryAfter ? parseInt(retryAfter) * 1000 : undefined;

            throw new PubMedApiError(errorType, errorMessage, response.status, retryAfterMs);
        }

        return await response.json();
    }

    private categorizeError(statusCode: number): PubMedErrorType {
        switch (statusCode) {
            case 429:
                return PubMedErrorType.RATE_LIMIT;
            case 404:
                return PubMedErrorType.NOT_FOUND;
            case 400:
                return PubMedErrorType.INVALID_QUERY;
            case 500:
            case 502:
            case 503:
            case 504:
                return PubMedErrorType.SERVER_ERROR;
            default:
                return PubMedErrorType.UNKNOWN;
        }
    }

    private getErrorMessage(statusCode: number, errorType: PubMedErrorType): string {
        switch (errorType) {
            case PubMedErrorType.RATE_LIMIT:
                return 'Too many requests. Please wait a moment before searching again. Consider using an API key for higher rate limits.';
            case PubMedErrorType.SERVER_ERROR:
                return 'PubMed servers are temporarily unavailable. Please try again in a few minutes.';
            case PubMedErrorType.NOT_FOUND:
                return 'No results found for your search query.';
            case PubMedErrorType.INVALID_QUERY:
                return 'Invalid search query. Please check your search terms and try again.';
            case PubMedErrorType.NETWORK_ERROR:
                return 'Network connection error. Please check your internet connection and try again.';
            default:
                return `Search failed with error code ${statusCode}. Please try again later.`;
        }
    }

    private shouldRetry(error: PubMedApiError, retryCount: number): boolean {
        if (retryCount >= this.MAX_RETRIES) {
            return false;
        }

        return error.type === PubMedErrorType.SERVER_ERROR ||
            error.type === PubMedErrorType.RATE_LIMIT ||
            error.type === PubMedErrorType.NETWORK_ERROR;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private getFromCache(key: string): CacheEntry | null {
        const entry = this.cache.get(key);
        if (!entry) {
            return null;
        }

        if (Date.now() - entry.timestamp > this.CACHE_DURATION) {
            this.cache.delete(key);
            return null;
        }

        return entry;
    }

    private setCache(key: string, entry: CacheEntry): void {
        if (this.cache.size >= this.MAX_CACHE_SIZE) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(key, entry);
    }

    private cleanupCache(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.CACHE_DURATION) {
                this.cache.delete(key);
            }
        }
    }

    static toSelectedPaper(paper: ScientificPaper): SelectedPaper {
        return {
            id: paper.doi || paper.title,
            title: paper.title,
            abstract: paper.abstract,
            authors: paper.authors,
            pubdate: paper.pubdate,
            doi: paper.doi
        };
    }

    static getInstance(): PubMedApiService {
        if (!PubMedApiService.instance) {
            PubMedApiService.instance = new PubMedApiService();
        }
        return PubMedApiService.instance;
    }

    private static instance: PubMedApiService;
}

export const pubmedApiService = PubMedApiService.getInstance();
export default pubmedApiService; 