import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from '../../lib/authOptions';
import { authorizeServiceRequest } from '../../lib/serviceApiAuth';
import { ChatMessage, geminiChat, geminiChatWithGrounding } from '../../lib/gemini';
import { getOrCreateCacheName } from '../../lib/geminiPromptCache';
import { constructRAGPrompt, findTopKChunks, getEmbeddings, performRAG, RAG_CONFIG, TextChunk } from '../../lib/rag';
import { getChunkFilesFromDrive, isChunkFile, loadChunkFile } from '../../lib/rag-gdrive';
import { loadRegistry } from '../../lib/rag/registry';
import { GeminiTools } from '../../lib/gemini';
import { isGalileoModel } from '../../lib/stepModels';
import { galileoPreflightResponse } from '../../lib/galileo/preflight.server';
import { readAgentInputRequest } from '../../lib/agentInputRequest';
import { agentInputStepResponse } from '../../lib/agentInputsExecution.server';
import { deleteGeminiFile, inferGeminiMimeType as inferMimeType, uploadFileToGeminiFilesAPI } from '../../lib/geminiFiles.server';

interface SelectedRagMetadata {
  id: string;
  filename?: string;
}

const FILE_SEARCH_SYSTEM_INSTRUCTION: ChatMessage = {
  role: 'system',
  text:
    'You have access to a File Search tool connected to one or more knowledge stores. ' +
    'Answer in your own words and be transformative: summarize and explain rather than reproducing long verbatim passages. ' +
    'If quoting is necessary, keep quotes short. If you cannot answer, explain what information is missing.',
};

const FILES_API_THRESHOLD = 5 * 1024 * 1024;

async function processSequentially(textPart: string, files: File[], model: string) {
  console.log(`🔄 [Sequential] Processing ${files.length} files one by one...`);

  let combinedResponse = '';

  for (const [index, file] of files.entries()) {
    try {
      console.log(`➡️ [Sequential] Processing file ${index + 1}/${files.length}: ${file.name}`);

      const geminiMessages: ChatMessage[] = [{
        role: 'user',
        text: textPart,
      }];

      const responseText = await geminiChat(geminiMessages, model);
      combinedResponse += `--- Analysis for ${file.name} ---\n${responseText}\n\n`;

    } catch (error) {
      console.error(`❌ [Sequential] Error processing ${file.name}:`, error);
      combinedResponse += `--- Error processing ${file.name} ---\nFailed to process this file: ${error instanceof Error ? error.message : 'Unknown error'}\n\n`;
    }
  }

  console.log('✅ [Sequential] All files processed');
  return NextResponse.json({ response: combinedResponse.trim() });
}

export const config = {
  api: { bodyParser: false },
};

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || '';
  console.log('📨 [Gemini API] Incoming request. Content-Type:', contentType);

  const session = await getServerSession(authOptions);
  if (!session) {
    const serviceAuth = authorizeServiceRequest(request);
    if (!serviceAuth.ok) {
      return NextResponse.json({ error: serviceAuth.error }, { status: serviceAuth.status });
    }
  }
  if (request.headers.get('x-agent-inputs') === '1') {
    try {
      const { raw, files } = await readAgentInputRequest(request);
      return agentInputStepResponse(raw, files, session, request.signal, uploadFileToGeminiFilesAPI, deleteGeminiFile);
    } catch {
      return NextResponse.json({ error: 'Invalid shared-input request.' }, { status: 400 });
    }
  }
  let auth = null;

  if (session?.accessToken) {
    try {
      const { google } = await import('googleapis');
      auth = new google.auth.OAuth2();
      auth.setCredentials({
        access_token: session.accessToken,
        refresh_token: session.refreshToken
      });
      console.log('🔐 [Gemini API] Google Drive authentication configured');
    } catch (authError) {
      console.warn('⚠️ [Gemini API] Failed to configure Google Drive auth:', authError);
    }
  }

  if (contentType.startsWith('multipart/form-data')) {
    try {
      const formData = await request.formData();
      console.log('🗂️ [Gemini API] Parsed form data fields:', Array.from(formData.keys()));

      const messages = formData.get('messages');
      const model = formData.get('model');
      if (isGalileoModel(model)) {
        const readiness = await galileoPreflightResponse(model);
        return readiness.ok ? NextResponse.json({ error: 'Use /api/galileo for this model.', code: 'INVALID_STEP_REQUEST' }, { status: 400 }) : readiness;
      }
      const ragKnowledgeData = formData.get('ragKnowledge');
      const projectId = formData.get('projectId');
      const systemInstructionData = formData.get('systemInstruction');
      const enablePromptCache = formData.get('enablePromptCache') === 'true';
      console.log('🔍 [Gemini API] RAG Knowledge in FormData:', ragKnowledgeData ? 'PRESENT' : 'MISSING');
      console.log('📁 [Gemini API] Project ID in FormData:', projectId ? projectId : 'NOT PROVIDED');
      console.log('📋 [Gemini API] System Instruction in FormData:', systemInstructionData ? 'PRESENT' : 'MISSING');
      const parts: { text?: string; inlineData?: { mimeType: string; data: string }; fileData?: { mimeType: string; fileUri: string } }[] = [];

      let parsedMessages: ChatMessage[] = [];
      try {
        parsedMessages = JSON.parse(messages as string);
        console.log('📝 [Gemini API] Parsed', parsedMessages.length, 'messages');
      } catch (e) {
        console.error('⚠️ [Gemini API] Failed to parse messages:', e);
      }

      if (parsedMessages.length > 0 && parsedMessages[0].text) {
        parts.push({ text: parsedMessages[0].text });
        console.log('✍️ [Gemini API] Added text part:', parsedMessages[0].text.includes('Collection'));
      }

      const files: File[] = [];

      for (const [, value] of formData.entries()) {
        if (value instanceof File) {
          const file = value;
          let emoji = '📄';
          const mimeType = file.type || inferMimeType(file.name);
          if (mimeType.startsWith('image/')) emoji = '🖼️';
          if (mimeType.startsWith('audio/')) emoji = '🎵';
          if (mimeType.startsWith('video/')) emoji = '🎬';

          console.log(`${emoji} [Gemini API] Processing file:`, {
            name: file.name,
            mimeType,
            size: file.size
          });

          files.push(file);

          if (file.size >= FILES_API_THRESHOLD) {
            console.log(`📤 [Gemini API] File size (${file.size} bytes) >= ${FILES_API_THRESHOLD} bytes, using Files API`);
            try {
              const fileUri = await uploadFileToGeminiFilesAPI(file);
              console.log(`✅ [Gemini API] File uploaded to Files API:`, fileUri);
              parts.push({ fileData: { mimeType, fileUri } });
            } catch (error) {
              console.error(`❌ [Gemini API] Files API upload failed:`, error);
              throw error;
            }
          } else {
            console.log(`📎 [Gemini API] File size (${file.size} bytes) < ${FILES_API_THRESHOLD} bytes, using inline data`);
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const data = buffer.toString('base64');
            parts.push({ inlineData: { mimeType, data } });
          }
        }
      }

      if (parts.length === 0) {
        parts.push({ text: '' });
        console.log('✍️ [Gemini API] No parts found, adding empty text part.');
      }

      const textPart = parts.find(p => p.text)?.text || '';
      const allInlineData = parts.filter(p => p.inlineData).map(p => p.inlineData!);
      const allFileData = parts.filter(p => p.fileData).map(p => p.fileData!);

      let ragChunks: TextChunk[] = [];
      let ragKnowledgeItems: SelectedRagMetadata[] = [];
      const fileSearchStoreNames: string[] = [];

      if (ragKnowledgeData) {
        try {
          ragKnowledgeItems = JSON.parse(ragKnowledgeData as string) as SelectedRagMetadata[];
          console.log(`🔍 [Gemini API] Received ${ragKnowledgeItems.length} RAG knowledge items from FormData metadata`);
        } catch (parseError) {
          console.error('❌ [Gemini API] Failed to parse RAG knowledge metadata:', parseError);
        }
      } else {
        console.log('⚠️ [Gemini API] No RAG knowledge found in FormData');
      }

      if (ragKnowledgeItems.length > 0 && auth) {
        try {
          console.log(`🎯 [Gemini API] Processing ${ragKnowledgeItems.length} RAG knowledge items`);

          for (const ragItem of ragKnowledgeItems) {
            const folderId = ragItem.id;
            const filename = ragItem.filename || '';

            if (folderId) {
              if (folderId.startsWith('filesearch-')) {
                console.log(`🔍 [Gemini API] Detected File Search Store ID: ${folderId}`);
                try {
                  const registry = await loadRegistry(auth);
                  const corpus = registry.corpora.find(c => c.id === folderId);
                  
                  if (corpus && corpus.corpusId) {
                    console.log(`✅ [Gemini API] Found matching store: ${corpus.displayName} (${corpus.corpusId})`);
                    fileSearchStoreNames.push(corpus.corpusId);
                  } else {
                    console.warn(`⚠️ [Gemini API] Could not find registry entry for store ID: ${folderId}`);
                  }
                } catch (registryError) {
                  console.error(`❌ [Gemini API] Failed to look up store in registry:`, registryError);
                }
                continue;
              }

              console.log(`📂 [Gemini API] Loading chunks for "${filename}" from folder ID: ${folderId}`);

              try {
                const chunks = await getChunkFilesFromDrive(folderId, auth);
                ragChunks = ragChunks.concat(chunks);
                console.log(`✅ [Gemini API] Loaded ${chunks.length} chunks for ${filename}`);
              } catch (chunkError) {
                console.error(`❌ [Gemini API] Failed to load chunks for ${filename} (ID: ${folderId}):`, chunkError);
              }
            } else {
              console.warn(`⚠️ [Gemini API] No folder ID found for RAG item: ${filename}`);
            }
          }
        } catch (ragError) {
          console.error('❌ [Gemini API] Error processing RAG knowledge metadata:', ragError);
        }
      }

      let totalPages = 0;
      const hasTextPrompt = textPart.trim().length > 0;
      const hasFiles = files.length > 0;

      if (hasFiles && hasTextPrompt) {
        for (const file of files) {
          if (file.type === 'application/pdf') {
            try {
              const arrayBuffer = await file.arrayBuffer();
              const { PDFDocument } = await import('pdf-lib');
              const pdfDoc = await PDFDocument.load(arrayBuffer);
              const pageCount = pdfDoc.getPageCount();
              totalPages += pageCount;
              console.log(`📄 [Gemini API] ${file.name}: ${pageCount} pages`);
            } catch (error) {
              console.warn(`⚠️ [RAG] Could not count pages for ${file.name}:`, error);
              totalPages += 100;
            }
          } else {
            const estimatedPages = Math.ceil(file.size / (1024 * 2));
            totalPages += estimatedPages;
            console.log(`📄 [Gemini API] ${file.name}: ~${estimatedPages} estimated pages`);
          }
        }

        console.log(`📊 [Gemini API] Total estimated pages: ${totalPages} across ${files.length} files`);
      }

      const useRAG = (hasFiles && hasTextPrompt && (
        (files.length > 1 && totalPages > 1000) ||
        (files.length === 1 && totalPages > 1000)
      )) || (ragChunks.length > 0);

      if (useRAG) {
        if (ragChunks.length > 0) {
          console.log(`🔍 [Gemini API] RAG knowledge references detected (${ragChunks.length} chunks). Using RAG approach.`);
        } else if (files.length === 1) {
          console.log(`🔍 [Gemini API] Single large file detected (${totalPages} pages > 1000 limit). Using RAG approach.`);
        } else {
          console.log(`🔍 [Gemini API] ${files.length} files with ${totalPages} total pages detected. Using RAG approach.`);
        }

        try {
          let allChunks: TextChunk[] = [];

          if (ragChunks.length > 0) {
            allChunks = allChunks.concat(ragChunks);
            console.log(`📚 [Gemini API] Added ${ragChunks.length} chunks from RAG knowledge references`);
          }

          const chunkFiles = files.filter(isChunkFile);
          const regularFiles = files.filter(f => !isChunkFile(f));

          console.log(`📂 [Gemini API] Found ${chunkFiles.length} chunk files and ${regularFiles.length} regular files`);

          for (const chunkFile of chunkFiles) {
            try {
              const chunks = await loadChunkFile(chunkFile);
              allChunks.push(...chunks);
              console.log(`📚 [Gemini API] Loaded ${chunks.length} chunks from ${chunkFile.name}`);
            } catch (chunkError) {
              console.error(`❌ [Gemini API] Failed to load chunk file ${chunkFile.name}:`, chunkError);
            }
          }

          if (regularFiles.length > 0) {
            console.log(`🔄 [Gemini API] Processing ${regularFiles.length} regular files with RAG...`);
            const ragResult = await performRAG(textPart, regularFiles, auth, false, projectId as string || undefined);

            if (ragResult.success && ragResult.chunks) {
              allChunks.push(...ragResult.chunks);
              console.log(`✅ [Gemini API] Added ${ragResult.chunks.length} chunks from regular file processing`);
            } else {
              console.error('❌ [RAG] Regular file processing failed:', ragResult.error);
              if (chunkFiles.length === 0) {
                console.log('🔄 [RAG] Falling back to sequential processing...');
                return await processSequentially(textPart, files, model as string);
              }
            }
          }

          if (allChunks.length > 0) {
            console.log(`🎯 [Gemini API] Performing semantic search on ${allChunks.length} total chunks`);

            const queryEmbedding = await getEmbeddings([textPart]);

            const topChunks = findTopKChunks(queryEmbedding[0], allChunks);
            console.log(`🔍 [Gemini API] Selected ${topChunks.length} most relevant chunks`);

            const ragContext = topChunks.map((chunk) =>
              `[Source: ${chunk.source}, Chunk ${chunk.chunkIndex}]\n${chunk.text}`
            ).join('\n\n---\n\n');

            const ragPrompt = constructRAGPrompt(textPart, ragContext);
            const ragMessages: ChatMessage[] = [{ role: 'user', text: ragPrompt }];

            const responseText = await geminiChat(ragMessages, model as string);

            const fileTypes = `${chunkFiles.length} pre-processed + ${regularFiles.length} new files`;
            const enhancedResponse = `${responseText}\n\n---\n*Analysis based on ${files.length} documents (${fileTypes}) - ${topChunks.length} most relevant sections selected from ${allChunks.length} total sections*`;

            return NextResponse.json({
              response: enhancedResponse,
              metadata: {
                totalFiles: files.length,
                chunkFiles: chunkFiles.length,
                regularFiles: regularFiles.length,
                totalChunks: allChunks.length,
                selectedChunks: topChunks.length
              }
            });
          } else {
            console.warn('⚠️ [Gemini API] No chunks available for processing');
            return await processSequentially(textPart, files, model as string);
          }

        } catch (ragError) {
          console.error('❌ [RAG] Unexpected error during enhanced RAG processing:', ragError);
          console.log('🔄 [RAG] Falling back to sequential processing...');
          return await processSequentially(textPart, files, model as string);
        }
      }

      if (hasFiles && hasTextPrompt && totalPages <= 1000) {
        console.log(`📋 [Gemini API] ${files.length} files detected with ${totalPages} total pages (≤1000). Using standard processing.`);
      } else if (hasFiles && !hasTextPrompt) {
        console.log(`📋 [Gemini API] Files detected but no text prompt. Using standard processing.`);
      }
      console.log('🧩 [Gemini API] Parts count:', parts.length, '(text + files)');
      console.log('📎 [Gemini API] Inline files:', allInlineData.length);
      console.log('📁 [Gemini API] Files API references:', allFileData.length);

      const geminiMessages: ChatMessage[] = [{
        role: 'user',
        text: textPart,
        ...(allInlineData.length === 1 ? { inlineData: allInlineData[0] } : {}),
        ...(allInlineData.length > 1 ? { inlineDataList: allInlineData } : {}),
        ...(allFileData.length === 1 ? { fileData: allFileData[0] } : {}),
        ...(allFileData.length > 1 ? { fileDataList: allFileData } : {})
      }];

      let parsedSystemInstruction: ChatMessage | undefined;
      if (systemInstructionData) {
        try {
          parsedSystemInstruction = JSON.parse(systemInstructionData as string) as ChatMessage;
          console.log('✅ [Gemini API] Parsed system instruction from FormData');
        } catch (e) {
          console.error('⚠️ [Gemini API] Failed to parse system instruction:', e);
        }
      }

      let tools: GeminiTools[] | undefined;
      
      if (fileSearchStoreNames.length > 0) {
        console.log(`🛠️ [Gemini API] Using File Search Tool with ${fileSearchStoreNames.length} stores`);
        tools = [{
          file_search: {
            file_search_store_names: fileSearchStoreNames
          }
        }];
      }

      let systemInstruction: ChatMessage | undefined;
      
      if (parsedSystemInstruction) {
        systemInstruction = parsedSystemInstruction;
        console.log('📋 [Gemini API] Using provided system instruction');
      } else if (fileSearchStoreNames.length > 0) {
        systemInstruction = FILE_SEARCH_SYSTEM_INSTRUCTION;
      }

      const cachedContent = enablePromptCache && !tools && systemInstruction?.text
        ? getOrCreateCacheName(model as string, systemInstruction.text)
        : undefined;

      const { text: responseText, grounding, reasoning, supports } = await geminiChatWithGrounding(geminiMessages, model as string, systemInstruction, tools, cachedContent);
      console.log('✅ [Gemini API] Response generated, length:', responseText?.length || 0);

      return NextResponse.json({ response: responseText, sources: grounding, reasoning, supports });
    } catch (error) {
      console.error('⚠️ [Gemini API] Error processing multipart form:', error);

      const errorMessage = error instanceof Error ? error.message : 'Failed to process multipart form data.';

      if (errorMessage.includes('429') || errorMessage.includes('Resource has been exhausted') || errorMessage.includes('check quota')) {
        return NextResponse.json({
          error: 'API quota has been exhausted. Please try again in a few minutes or check your quota limits.',
          errorType: 'API_QUOTA_EXHAUSTED',
          originalError: errorMessage
        }, { status: 429 });
      }

      if (errorMessage.includes('Document Too Large') || errorMessage.includes('input token count exceeds')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'TOKEN_LIMIT_EXCEEDED',
          suggestion: 'Try reducing the number of files or splitting large documents into smaller chunks before uploading.'
        }, { status: 400 });
      }

      if (errorMessage.includes('exceeds the supported page limit') ||
        errorMessage.includes('page limit')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'PAGE_LIMIT_EXCEEDED'
        }, { status: 400 });
      }

      if (errorMessage.includes('INVALID_ARGUMENT')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'INVALID_ARGUMENT'
        }, { status: 400 });
      }

      if (errorMessage.includes('RECITATION_BLOCKED')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'RECITATION_BLOCKED',
          suggestion: 'Try asking for a summary in your own words (e.g. “summarize chapter 3”), or ask a specific question (e.g. “what are the key findings?”). Avoid asking for verbatim passages.'
        }, { status: 400 });
      }

      if (errorMessage.includes('authentication') || errorMessage.includes('401')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'AUTHENTICATION_ERROR'
        }, { status: 401 });
      }

      const statusMatch = errorMessage.match(/Gemini API (\d{3}):/);
      const extractedStatus = statusMatch ? parseInt(statusMatch[1]) : 500;

      return NextResponse.json({
        error: errorMessage,
        errorType: 'PROCESSING_ERROR'
      }, { status: extractedStatus });
    }
  } else {
    try {
      console.log('🗒️ [Gemini API] Parsing JSON body...');
      const { messages, model, ragKnowledge, systemInstruction: requestSystemInstruction, enablePromptCache }: {
        messages: ChatMessage[];
        model: string;
        ragKnowledge?: SelectedRagMetadata[];
        systemInstruction?: ChatMessage;
        enablePromptCache?: boolean;
      } = await request.json();
      if (isGalileoModel(model)) {
        const readiness = await galileoPreflightResponse(model);
        return readiness.ok ? NextResponse.json({ error: 'Use /api/galileo for this model.', code: 'INVALID_STEP_REQUEST' }, { status: 400 }) : readiness;
      }
      console.log('📝 [Gemini API] Processing', messages?.length || 0, 'messages');
      console.log('🔍 [Gemini API] RAG Knowledge in request:', ragKnowledge ? `${ragKnowledge.length} items` : 'NONE');
      console.log('📋 [Gemini API] System Instruction in request:', requestSystemInstruction ? 'PRESENT' : 'MISSING');

      let ragChunks: TextChunk[] = [];
      const fileSearchStoreNames: string[] = [];

      if (ragKnowledge && ragKnowledge.length > 0 && auth) {
        console.log(`✅ [Gemini API] Received ${ragKnowledge.length} RAG knowledge items from JSON metadata`);

        try {
          console.log(`🎯 [Gemini API] Processing ${ragKnowledge.length} RAG knowledge items`);

          for (let i = 0; i < ragKnowledge.length; i++) {
            const ragItem = ragKnowledge[i] as SelectedRagMetadata;
            const folderId = ragItem.id;
            const filename = ragItem.filename || '';

            console.log(`📂 [Gemini API] Processing RAG item ${i + 1}/${ragKnowledge.length}:`);
            console.log(`   📄 ID: ${folderId}`);
            console.log(`   📄 Filename: ${filename}`);

            if (folderId) {
              if (folderId.startsWith('filesearch-')) {
                console.log(`🔍 [Gemini API] Detected File Search Store ID: ${folderId}`);
                try {
                  const registry = await loadRegistry(auth);
                  const corpus = registry.corpora.find(c => c.id === folderId);
                  
                  if (corpus && corpus.corpusId) {
                    console.log(`✅ [Gemini API] Found matching store: ${corpus.displayName} (${corpus.corpusId})`);
                    fileSearchStoreNames.push(corpus.corpusId);
                  } else {
                    console.warn(`⚠️ [Gemini API] Could not find registry entry for store ID: ${folderId}`);
                  }
                } catch (registryError) {
                  console.error(`❌ [Gemini API] Failed to look up store in registry:`, registryError);
                }
                continue;
              }

              console.log(`🔄 [Gemini API] Calling getChunkFilesFromDrive for folder ID: ${folderId}`);

              try {
                const chunks = await getChunkFilesFromDrive(folderId, auth);
                console.log(`📦 [Gemini API] getChunkFilesFromDrive returned ${chunks.length} chunks`);

                if (chunks.length > 0) {
                  console.log(`   📊 Sample chunk info:`, {
                    firstChunkLength: chunks[0].text?.length,
                    hasEmbedding: !!chunks[0].embedding,
                    source: chunks[0].source
                  });
                }

                ragChunks = ragChunks.concat(chunks);
                console.log(`✅ [Gemini API] Loaded ${chunks.length} chunks for ${filename}. Total chunks so far: ${ragChunks.length}`);
              } catch (chunkError) {
                console.error(`❌ [Gemini API] Failed to load chunks for ${filename} (ID: ${folderId}):`, chunkError);
                console.error(`❌ [Gemini API] Error details:`, chunkError);
              }
            } else {
              console.warn(`⚠️ [Gemini API] No folder ID found for RAG item: ${filename}`);
            }
          }

          console.log(`🎉 [Gemini API] RAG processing complete. Total chunks loaded: ${ragChunks.length}`);

        } catch (ragError) {
          console.error('❌ [Gemini API] Error processing RAG knowledge metadata:', ragError);
          console.error('❌ [Gemini API] Error stack:', ragError);
        }
      } else if (!ragKnowledge || ragKnowledge.length === 0) {
        console.log('⚠️ [Gemini API] No RAG knowledge found in JSON request - ragKnowledge is empty or missing');
        console.log('🔍 [Gemini API] ragKnowledge value:', ragKnowledge);
      } else if (!auth) {
        console.log('⚠️ [Gemini API] No Google Drive auth - cannot load RAG knowledge');
      }

      if (ragChunks.length > 0) {
        console.log(`🎯 [Gemini API] Using RAG processing with ${ragChunks.length} chunks`);

        const textContent = messages.map((m) => m.text || '').join(' ');

        const queryEmbedding = await getEmbeddings([textContent]);

        const topChunks = findTopKChunks(queryEmbedding[0], ragChunks, RAG_CONFIG.TOP_K_CHUNKS, textContent);
        console.log(`🔍 [Gemini API] Selected ${topChunks.length} most relevant chunks`);

        const ragContext = topChunks.map((chunk) =>
          `[Source: ${chunk.source}, Chunk ${chunk.chunkIndex}]\n${chunk.text}`
        ).join('\n\n---\n\n');

        const ragPrompt = constructRAGPrompt(textContent, ragContext);
        const ragMessages: ChatMessage[] = [{ role: 'user', text: ragPrompt }];

        const responseText = await geminiChat(ragMessages, model as string);

        const enhancedResponse = `${responseText}\n\n---\n*Analysis based on RAG knowledge - ${topChunks.length} most relevant sections selected from ${ragChunks.length} total sections*`;

        console.log('✅ [Gemini API] RAG response generated, length:', enhancedResponse?.length || 0);

        return NextResponse.json({
          response: enhancedResponse,
          metadata: {
            totalChunks: ragChunks.length,
            selectedChunks: topChunks.length
          }
        });
      } else {
        
        let tools: GeminiTools[] | undefined;
        
        if (fileSearchStoreNames.length > 0) {
          console.log(`🛠️ [Gemini API] Using File Search Tool with ${fileSearchStoreNames.length} stores`);
          tools = [{
            file_search: {
              file_search_store_names: fileSearchStoreNames
            }
          }];
        }

        let systemInstruction: ChatMessage | undefined;

        if (requestSystemInstruction) {
          systemInstruction = requestSystemInstruction;
          console.log('📋 [Gemini API] Using provided system instruction from JSON');
        } else if (fileSearchStoreNames.length > 0) {
          systemInstruction = FILE_SEARCH_SYSTEM_INSTRUCTION;
        }

        // Reuse an explicit context cache for the stable system instruction when
        // the caller opts in and the request carries no tools (tool/file-search
        // steps are excluded — their tools would also need caching to stay valid).
        const cachedContent = enablePromptCache && !tools && systemInstruction?.text
          ? getOrCreateCacheName(model, systemInstruction.text)
          : undefined;

        const { text: responseText, grounding, reasoning, supports } = await geminiChatWithGrounding(messages, model, systemInstruction, tools, cachedContent);
        console.log(`✅ [Gemini API] Response generated, length: ${responseText?.length || 0}`);

        return NextResponse.json({ response: responseText, sources: grounding, reasoning, supports });
      }
    } catch (error) {
      console.error('⚠️ [Gemini API] Error processing JSON body:', error);

      const errorMessage = error instanceof Error ? error.message : 'Failed to process request.';

      if (errorMessage.includes('exceeds the supported page limit') ||
        errorMessage.includes('page limit')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'PAGE_LIMIT_EXCEEDED'
        }, { status: 400 });
      }

      if (errorMessage.includes('INVALID_ARGUMENT')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'INVALID_ARGUMENT'
        }, { status: 400 });
      }

      if (errorMessage.includes('RECITATION_BLOCKED')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'RECITATION_BLOCKED',
          suggestion: 'Try asking for a summary in your own words (e.g. “summarize chapter 3”), or ask a specific question (e.g. “what are the key findings?”). Avoid asking for verbatim passages.'
        }, { status: 400 });
      }

      if (errorMessage.includes('authentication') || errorMessage.includes('401')) {
        return NextResponse.json({
          error: errorMessage,
          errorType: 'AUTHENTICATION_ERROR'
        }, { status: 401 });
      }

      return NextResponse.json({
        error: errorMessage,
        errorType: 'PROCESSING_ERROR'
      }, { status: 500 });
    }
  }
}

