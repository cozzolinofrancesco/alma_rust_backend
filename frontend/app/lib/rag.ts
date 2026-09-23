import type { drive_v3 } from 'googleapis';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_MODEL } from './modelConfig';
import { fetchWithTimeout } from './fetchWithTimeout';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export const RAG_CONFIG = {
  MAX_FILES: 5,
  MAX_CHUNKS_PER_FILE: 200,
  MAX_TOTAL_CHUNKS: 400,
  MAX_TOTAL_CHARS: 2_500_000,
  CHUNK_SIZE: 1000,
  CHUNK_OVERLAP: 100,
  TOP_K_CHUNKS: 15,
  MAX_CONTEXT_TOKENS: 8000,
  PAGE_THRESHOLD: 1000,
} as const;

export interface TextChunk {
  text: string;
  source: string;
  chunkIndex: number;
  embedding?: number[];
}

export interface RAGResult {
  success: boolean;
  response?: string;
  chunks?: TextChunk[];
  error?: string;
  metadata?: {
    totalFiles: number;
    totalChunks: number;
    selectedChunks: number;
    processingTimeMs: number;
  };
}

export async function extractTextFromPDF(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const pageCount = pdfDoc.getPageCount();

    console.log(`📄 [RAG] Processing PDF: ${file.name} (${pageCount} pages)`);

    if (pageCount <= 800) {
      console.log(`📄 [RAG] PDF under 800 pages, processing directly`);
      const base64Data = Buffer.from(arrayBuffer).toString('base64');

      const response = await fetchWithTimeout(
        `${GEMINI_BASE_URL}/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                {
                  text: 'Extract all text content from this PDF document. Return only the extracted text without any additional commentary or formatting.'
                },
                {
                  inlineData: {
                    mimeType: 'application/pdf',
                    data: base64Data
                  }
                }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              topP: 0.95,
              topK: 20,
              maxOutputTokens: 65535
            }
          }),
        }
      );

      if (response.ok) {
        const result = await response.json();
        const extractedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (extractedText) {
          console.log(`✅ [RAG] Extracted ${extractedText.length} characters from ${file.name}`);
          return extractedText;
        }
      }
    }

    console.log(`📄 [RAG] PDF has ${pageCount} pages, splitting into ranges for processing`);
    const pagesPerChunk = 500;
    const allExtractedText: string[] = [];

    for (let startPage = 0; startPage < pageCount; startPage += pagesPerChunk) {
      const endPage = Math.min(startPage + pagesPerChunk - 1, pageCount - 1);
      console.log(`📄 [RAG] Processing pages ${startPage + 1}-${endPage + 1}`);

      try {
        const subPdf = await PDFDocument.create();
        const pageIndices = Array.from({ length: endPage - startPage + 1 }, (_, i) => startPage + i);
        const copiedPages = await subPdf.copyPages(pdfDoc, pageIndices);
        copiedPages.forEach(page => subPdf.addPage(page));

        const subPdfBytes = await subPdf.save();
        const subPdfBase64 = Buffer.from(subPdfBytes).toString('base64');

        const response = await fetchWithTimeout(
          `${GEMINI_BASE_URL}/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [{
                role: 'user',
                parts: [
                  {
                    text: 'Extract all text content from this PDF document. Return only the extracted text without any additional commentary or formatting.'
                  },
                  {
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: subPdfBase64
                    }
                  }
                ]
              }],
              generationConfig: {
                temperature: 0.1,
                topP: 0.95,
                topK: 20,
                maxOutputTokens: 65535
              }
            }),
          }
        );

        if (response.ok) {
          const result = await response.json();
          const chunkText = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (chunkText) {
            allExtractedText.push(`\n--- Pages ${startPage + 1}-${endPage + 1} ---\n${chunkText}`);
            console.log(`✅ [RAG] Extracted ${chunkText.length} characters from pages ${startPage + 1}-${endPage + 1}`);
          }
        } else {
          console.warn(`⚠️ [RAG] Failed to extract text from pages ${startPage + 1}-${endPage + 1}`);
          allExtractedText.push(`\n--- Pages ${startPage + 1}-${endPage + 1} ---\n[Text extraction failed for this page range]`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`❌ [RAG] Error processing pages ${startPage + 1}-${endPage + 1}:`, error);
        allExtractedText.push(`\n--- Pages ${startPage + 1}-${endPage + 1} ---\n[Error extracting text from this page range]`);
      }
    }

    const combinedText = allExtractedText.join('\n');
    console.log(`✅ [RAG] Combined text extraction complete: ${combinedText.length} total characters`);
    return combinedText;

  } catch (error) {
    console.error('Error in PDF text extraction:', error);
    return `[PDF Document: ${file.name} - Text extraction error: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }
}

export async function extractTextFromFile(file: File): Promise<string> {
  const mimeType = file.type;

  if (mimeType === 'application/pdf') {
    return extractTextFromPDF(file);
  }

  if (mimeType.startsWith('text/')) {
    return await file.text();
  }

  return `[File ${file.name} - Content extraction for ${mimeType} not implemented]`;
}

export function chunkText(text: string, source: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const chunkSize = RAG_CONFIG.CHUNK_SIZE * 4;
  const overlap = RAG_CONFIG.CHUNK_OVERLAP * 4;

  let start = 0;
  let chunkIndex = 0;

  while (start < text.length && chunkIndex < RAG_CONFIG.MAX_CHUNKS_PER_FILE) {
    const end = Math.min(start + chunkSize, text.length);
    const chunkText = text.slice(start, end);

    if (chunkText.trim().length > 50) {
      chunks.push({
        text: chunkText.trim(),
        source,
        chunkIndex,
      });
    }

    chunkIndex++;
    start = end - overlap;
  }

  return chunks;
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const maxRetries = 3;
  const baseDelay = 1000;
  const batchSize = 10;

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    console.log(`🧮 [RAG] Processing embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} items)`);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const batchEmbeddings: number[][] = [];

        for (const text of batch) {
          const response = await fetchWithTimeout(
            `${GEMINI_BASE_URL}/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                content: {
                  parts: [{ text: text.substring(0, 20000) }]
                }
              }),
            }
          );

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Embedding API ${response.status}: ${errorText}`);
          }

          const result = await response.json();

          if (result.embedding && result.embedding.values) {
            batchEmbeddings.push(result.embedding.values);
          } else {
            throw new Error('Unexpected embedding response format');
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }

        allEmbeddings.push(...batchEmbeddings);
        break;

      } catch (error) {
        console.error(`Embedding batch attempt ${attempt + 1}/${maxRetries} failed:`, error);

        if (attempt === maxRetries - 1) {
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (i + batchSize < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return allEmbeddings;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function findTopKChunks(
  queryEmbedding: number[],
  chunks: TextChunk[],
  k: number = RAG_CONFIG.TOP_K_CHUNKS,
  queryText?: string
): TextChunk[] {
  const chunksWithEmbeddings = chunks.filter(chunk => chunk.embedding);
  const chunksWithoutEmbeddings = chunks.filter(chunk => !chunk.embedding);

  if (chunksWithoutEmbeddings.length > 0) {
    console.warn(`⚠️ [RAG] Found ${chunksWithoutEmbeddings.length} chunks without embeddings - using text similarity fallback`);
  }

  const semanticSimilarities = chunksWithEmbeddings.map(chunk => ({
    chunk,
    similarity: cosineSimilarity(queryEmbedding, chunk.embedding!),
    type: 'semantic' as const
  }));

  const textSimilarities = chunksWithoutEmbeddings.map(chunk => ({
    chunk,
    similarity: queryText ? calculateTextSimilarity(queryText, chunk.text) : 0.1,
    type: 'textual' as const
  }));

  const allSimilarities = [
    ...semanticSimilarities,
    ...textSimilarities.map(item => ({ ...item, similarity: item.similarity * 0.5 }))
  ];

  const topChunks = allSimilarities
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
    .map(item => item.chunk);

  const semanticCount = topChunks.filter(chunk => chunk.embedding).length;
  const textualCount = topChunks.length - semanticCount;

  if (textualCount > 0) {
    console.log(`📊 [RAG] Selected ${semanticCount} semantic + ${textualCount} textual chunks (total: ${topChunks.length})`);
  } else {
    console.log(`📊 [RAG] Selected ${topChunks.length} chunks using semantic similarity`);
  }

  return topChunks;
}

function calculateTextSimilarity(query: string, text: string): number {
  if (!query || !text) return 0;

  const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
  const textWords = text.toLowerCase().split(/\s+/);

  if (queryWords.length === 0) return 0;

  const matchCount = queryWords.filter(word =>
    textWords.some(textWord => textWord.includes(word) || word.includes(textWord))
  ).length;

  return matchCount / queryWords.length;
}

export async function performRAG(
  query: string,
  files: File[],
  auth?: unknown,
  replaceExisting?: boolean,
  projectId?: string
): Promise<RAGResult> {
  const startTime = Date.now();

  try {
    if (files.length > RAG_CONFIG.MAX_FILES) {
      return {
        success: false,
        error: `Too many files. Maximum allowed: ${RAG_CONFIG.MAX_FILES}`,
      };
    }

    console.log(`🔍 [RAG] Starting processing for ${files.length} files`);

    console.log('📄 [RAG] Step 1: Extracting text...');
    const extractionPromises = files.map(file =>
      extractTextFromFile(file).catch(error => {
        console.error(`Failed to extract text from ${file.name}:`, error);
        return `[Error extracting text from ${file.name}]`;
      })
    );

    const extractedTexts = await Promise.all(extractionPromises);

    console.log('✂️ [RAG] Step 2: Chunking text...');
    let allChunks: TextChunk[] = [];

    for (let i = 0; i < files.length; i++) {
      const text = extractedTexts[i];
      if (text.length > RAG_CONFIG.MAX_TOTAL_CHARS) {
        return {
          success: false,
          error: `File ${files[i].name} is too large. Maximum: ${RAG_CONFIG.MAX_TOTAL_CHARS} characters`,
        };
      }

      const chunks = chunkText(text, files[i].name);
      allChunks = allChunks.concat(chunks);
    }

    if (allChunks.length > RAG_CONFIG.MAX_TOTAL_CHUNKS) {
      return {
        success: false,
        error: `Too many chunks generated (${allChunks.length}). Maximum: ${RAG_CONFIG.MAX_TOTAL_CHUNKS}`,
      };
    }

    console.log(`📦 [RAG] Generated ${allChunks.length} chunks from ${files.length} files`);

    console.log('🧮 [RAG] Step 3: Computing embeddings...');
    const textsToEmbed = [query, ...allChunks.map(chunk => chunk.text)];

    const embeddings = await getEmbeddings(textsToEmbed);
    const queryEmbedding = embeddings[0];

    for (let i = 0; i < allChunks.length; i++) {
      allChunks[i].embedding = embeddings[i + 1];
    }

    console.log('🎯 [RAG] Step 4: Finding relevant chunks...');
    const topChunks = findTopKChunks(queryEmbedding, allChunks);

    console.log('📝 [RAG] Step 5: Constructing context...');
    const contextSections = topChunks.map((chunk) =>
      `[Source: ${chunk.source}, Chunk ${chunk.chunkIndex}]\n${chunk.text}`
    ).join('\n\n---\n\n');

    const processingTime = Date.now() - startTime;

    if (auth && files.length === 1) {
      try {
        console.log('💾 [RAG] Saving chunk folder to project...');
        const { ProjectService } = await import('./project-service');
        const { createChunksFolder, checkExistingChunkFolder } = await import('./rag-gdrive');

        const projectService = new ProjectService(auth as drive_v3.Options['auth']);
        const projectContext = await projectService.detectProjectContext(files[0].name, projectId);

        if (projectContext) {
          console.log(`📁 [RAG] Using project: ${projectContext.projectName} (${projectContext.projectFolderId})`);
          console.log(`📁 [RAG] RAG folder: ${projectContext.ragFolderId}`);

          const { google } = await import('googleapis');
          const drive = google.drive({ version: 'v3', auth: auth as drive_v3.Options['auth'] });
          const baseName = files[0].name.replace(/\.pdf$/i, '');
          const folderName = `${baseName}_Chunks`;

          const existingFolder = await checkExistingChunkFolder(drive, folderName, projectContext.ragFolderId);

          if (existingFolder.exists && !replaceExisting) {
            console.log(`⚠️ [RAG] Chunk folder already exists in project: ${folderName} - skipping creation to avoid duplicates`);
            console.log(`📋 [RAG] Using existing chunk folder in project: ${folderName}`);
          } else {
            const shouldReplace = existingFolder.exists && replaceExisting;
            const createdFolderName = await createChunksFolder(
              files[0].name,
              allChunks,
              auth as drive_v3.Options['auth'],
              shouldReplace,
              projectContext.ragFolderId
            );
            if (shouldReplace) {
              console.log(`🔄 [RAG] Replaced existing chunk folder in project: ${createdFolderName}`);
            } else {
              console.log(`✅ [RAG] Created new chunk folder in project: ${createdFolderName}`);
            }
          }
        } else {
          throw new Error('RAG processing failed: unable to resolve project context. Ensure an ALMA project exists and you have access permissions.');
        }
      } catch (chunkError) {
        console.error('❌ [RAG] Failed to save chunk folder:', chunkError);

        if (chunkError instanceof Error &&
          (chunkError.message.includes('No ALMA projects found') ||
            chunkError.message.includes('Cannot access project') ||
            chunkError.message.includes('Permission denied'))) {
          console.error('❌ [RAG] Critical project context error, stopping processing:', chunkError.message);
          throw chunkError;
        } else {
          console.warn('⚠️ [RAG] Non-critical chunk saving error, continuing with RAG processing:', chunkError);
        }
      }
    }

    return {
      success: true,
      response: contextSections,
      chunks: allChunks,
      metadata: {
        totalFiles: files.length,
        totalChunks: allChunks.length,
        selectedChunks: topChunks.length,
        processingTimeMs: processingTime,
      },
    };

  } catch (error) {
    console.error('❌ [RAG] Error during processing:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown RAG processing error',
    };
  }
}

export function constructRAGPrompt(query: string, ragContext: string): string {
  return `Based on the following document excerpts, please answer the question. Use information from the provided sources and cite which document/section you're referencing when possible. Synthesize information from multiple documents when relevant.

QUESTION: ${query}

DOCUMENT EXCERPTS:
${ragContext}

INSTRUCTIONS:
- Provide a comprehensive answer that draws from all relevant sources
- When referencing information, mention the source document name
- If documents contain conflicting information, acknowledge the differences
- Focus on the most relevant information to answer the question

ANSWER:`;
}
