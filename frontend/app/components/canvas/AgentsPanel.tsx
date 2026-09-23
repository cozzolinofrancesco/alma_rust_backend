'use client';

import { useTheme } from '../../contexts/ThemeContext';
import { useProjectState } from '../ProjectStateContext';
import { useEditor } from '../../contexts/EditorContext';
import { useDocument } from '../../contexts/DocumentContext';
import { useAgentSteps } from '../../contexts/AgentStepContext';
import { useIntegrityChain } from '../../contexts/IntegrityChainContext';
import { createIntegrityRecord } from '../../lib/integrity';
import IntegrityChainModal from '../IntegrityChainModal';
import { fetchAgentFiles } from '../../lib/api';
import { DEFAULT_MODEL, isValidModel } from '../../lib/modelConfig';
import { filterAIResponseSections } from '../../lib/filterAIStepOutput';
import { resolveSubsetFilter } from '../../rag-optimization/lib/metadataFilter';
import { fetchCorpusDocsForFilter } from '../../rag-optimization/lib/corpusDocs';
import { useSession } from 'next-auth/react';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FaRobot, FaSpinner, FaPlay, FaSyncAlt, FaPlus, FaChevronDown, FaChevronRight } from 'react-icons/fa';
import AgentNameModal from '../AgentNameModal';

interface BibliographyItem {
  path?: string;
  name?: string;
  type?: string;
  description?: string;
}

interface Layer {
  id: string;
  name: string;
  type: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  userInstruction: string;
  systemInstruction?: string;
  selectedModel?: string;
  outputType?: 'basic' | 'code' | string;
  collection?: string;
  imageUrls?: string[];
  urlContent?: string[];
  bibliography?: BibliographyItem[];
  isActive: boolean;
  order: number;
}

interface AgentData {
  version?: string;
  name: string;
  layers: Layer[];
  metadata?: {
    created?: string;
    modified?: string;
    description?: string;
  };
}

interface DashboardAgent {
  id: string;
  name: string;
  created: string;
  createdAt: string;
  modifiedAt: string;
  description?: string;
}

type AgentSortBy = 'modified-desc' | 'modified-asc' | 'created-desc' | 'created-asc';

interface VersionedAgentData {
  agentName: string;
  currentVersion: string;
  versions: Array<{
    version: string;
    layers: Layer[];
    timestamp: string;
    [key: string]: unknown;
  }>;
  metadata?: {
    created?: string;
    modified?: string;
    description?: string;
  };
}

type AgentDataUnion = AgentData | VersionedAgentData | null | undefined;

export default function AgentsPanel() {
    const { theme } = useTheme();
    const { projectFolder } = useProjectState();
    const { data: session, status } = useSession();
    const { clearContent } = useEditor();
    const { activeSection, updateSectionContent, getCurrentSectionContent } = useDocument();
    const { setAgentSteps, setActiveStepId, setStepContent, setStepCorpusIds, stepCorpusIds, clearAgentSteps } = useAgentSteps();
    const { appendRecord, getChain, chainLength, saveChain, listChains, loadChain } = useIntegrityChain();
    const [showIntegrityModal, setShowIntegrityModal] = useState(false);
    const [agents, setAgents] = useState<DashboardAgent[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedAgent, setSelectedAgent] = useState<AgentData | null>(null);
    const [loadingAgent, setLoadingAgent] = useState<string | null>(null);
    
    const [stepFiles, setStepFiles] = useState<Record<string, File[]>>({});
    const [stepResults, setStepResults] = useState<Record<string, string>>({});
    const [runningSteps, setRunningSteps] = useState<Record<string, boolean>>({});
    const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
    
    const [expandedCompletedSteps, setExpandedCompletedSteps] = useState<Set<string>>(new Set());
    
    const [availableCorpora, setAvailableCorpora] = useState<Array<{
        id: string;
        displayName: string;
        files?: Array<{ name: string; status: string }>;
    }>>([]);
    
    const [stepDocumentSelections, setStepDocumentSelections] = useState<Record<string, string[]>>({});
    const [stepBibliographyBypass, setStepBibliographyBypass] = useState<Record<string, boolean>>({});
    const [stepCorpusDocuments, setStepCorpusDocuments] = useState<Record<string, Array<{ pdfName: string; state: string }>>>({});
    const [stepCorpusDocumentsLoading, setStepCorpusDocumentsLoading] = useState<Record<string, boolean>>({});
    
    const [agentSortBy, setAgentSortBy] = useState<AgentSortBy>('modified-desc');

    const [isCreatingAgent, setIsCreatingAgent] = useState(false);
    const [showNameModal, setShowNameModal] = useState(false);
    const [nameModalError, setNameModalError] = useState<string | null>(null);

    const loadAgents = useCallback(async () => {
        console.log('🔄 AgentsPanel: Loading agents...', { 
            projectId: projectFolder?.projectId, 
            hasToken: !!session?.accessToken,
            status
        });

        if (session?.error === 'RefreshAccessTokenError') {
            setAgents([]);
            setError('Your session has expired. Please sign in again.');
            return;
        }

        if (!projectFolder?.projectId) {
            setAgents([]);
            setError('No project selected');
            console.log('❌ AgentsPanel: No project selected');
            return;
        }

        if (!session?.accessToken) {
            setAgents([]);
            setError('Please sign in to load agents');
            console.log('❌ AgentsPanel: No access token');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const agentFiles = await fetchAgentFiles(projectFolder.projectId);
            const dashboardAgents: DashboardAgent[] = agentFiles.map(file => ({
                id: file.id,
                name: file.name,
                created: new Date(file.createdAt).toLocaleString(),
                createdAt: file.createdAt || new Date().toISOString(),
                modifiedAt: file.updatedAt || file.createdAt || new Date().toISOString(),
                description: undefined
            }));
            setAgents(dashboardAgents);
            console.log('✅ AgentsPanel: Loaded agents successfully', { count: dashboardAgents.length });
        } catch (err) {
            console.error('❌ AgentsPanel: Error loading agents:', err);
            setError('Failed to load agents');
            setAgents([]);
        } finally {
            setLoading(false);
        }
    }, [projectFolder?.projectId, session?.accessToken, status]);

    const loadCorpora = useCallback(async (signal?: AbortSignal) => {
        if (!session?.accessToken) return;
        try {
            const response = await fetch('/api/rag/corpora', { credentials: 'include', signal });
            if (response.ok) {
                const data = await response.json();
                const corpora = (data.corpora || []).map((c: {
                    id: string;
                    displayName: string;
                    files?: Array<{ name: string; status: string }>;
                }) => ({
                    id: c.id,
                    displayName: c.displayName,
                    files: c.files || [],
                }));
                setAvailableCorpora(corpora);
                console.log('✅ AgentsPanel: Loaded corpora', { count: corpora.length });
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return;
            console.warn('AgentsPanel: Corpora fetch failed (RAG may be unavailable):', error instanceof Error ? error.message : error);
        }
    }, [session?.accessToken]);

    const loadAgentData = useCallback(async (agentId: string) => {
        if (!projectFolder?.projectId) return;
        
        if (!session?.accessToken) {
            setError('Please sign in to load agent details');
            return;
        }

        setLoadingAgent(agentId);
        
        try {
            const response = await fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files/${agentId}`, {
                headers: {
                    'Authorization': `Bearer ${session.accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to load agent: ${response.statusText}`);
            }

            const responseData = await response.json();
            
            let agentData;
            if (typeof responseData.content === 'string') {
                try {
                    agentData = JSON.parse(responseData.content);
                } catch {
                    throw new Error('Invalid JSON in agent file');
                }
            } else {
                agentData = responseData;
            }
            
            console.log('📋 Canvas: Loaded agent data structure:', {
                hasLayers: !!agentData?.layers,
                hasVersions: !!agentData?.versions,
                isVersioned: !!(agentData?.versions && agentData?.currentVersion),
                agentName: agentData?.name || agentData?.agentName,
                layerCount: agentData?.layers?.length || 0,
                versionCount: agentData?.versions?.length || 0
            });
            
            setSelectedAgent(agentData);
            
            const allLayers = extractLayers(agentData);
            const activeLayers = allLayers
                .filter(layer => layer.id && layer.name && layer.isActive !== false)
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            setAgentSteps(activeLayers.map((layer, i) => ({ id: layer.id, name: layer.name, index: i })));
            
            clearContent();
            console.log('🧹 Canvas: Cleared main editor for new agent execution');
        } catch (err) {
            console.error('Error loading agent data:', err);
            setError('Failed to load agent details');
        } finally {
            setLoadingAgent(null);
        }
    }, [projectFolder?.projectId, session?.accessToken, clearContent]);

    useEffect(() => {
        if (status === 'loading') return;
        loadAgents();
        if (!session?.accessToken) return;
        const ac = new AbortController();
        loadCorpora(ac.signal);
        return () => ac.abort();
    }, [loadAgents, loadCorpora, session?.accessToken, status]);

    useEffect(() => {
        if (!selectedAgent) return;
        const layers = extractLayers(selectedAgent);
        let next: Record<string, string[]> | null = null;
        layers.forEach((layer) => {
            if (stepBibliographyBypass[layer.id]) return;
            const corpusId = stepCorpusIds[layer.id];
            const docs = stepCorpusDocuments[layer.id];
            if (!corpusId || !docs?.length) return;
            const hasBib = layer.bibliography && layer.bibliography.length > 0;
            if (!hasBib || !layer.bibliography) return;
            const bibNames = new Set<string>();
            for (const b of layer.bibliography) {
                const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                const fromName = b.name?.trim();
                if (fromPath) bibNames.add(fromPath);
                if (fromName) bibNames.add(fromName);
            }
            const isInBib = (pdfName: string) =>
                Array.from(bibNames).some(bn => pdfName === bn || pdfName.endsWith(bn) || pdfName.includes(bn));
            const bibOnly = docs
                .filter((d) => d.state !== 'FAILED' && isInBib(d.pdfName))
                .map((d) => d.pdfName);
            const current = stepDocumentSelections[layer.id] || [];
            const bibSet = new Set(bibOnly);
            const hasNonBib = current.some((n: string) => !bibSet.has(n));
            if (hasNonBib && bibOnly.length > 0) {
                next = next ?? { ...stepDocumentSelections };
                next[layer.id] = bibOnly;
            }
        });
        if (next) setStepDocumentSelections(next);
    }, [selectedAgent, stepCorpusIds, stepCorpusDocuments, stepDocumentSelections, stepBibliographyBypass]);

    const sortedAgents = useMemo(() => {
        const list = [...agents];
        list.sort((a, b) => {
            const aCreated = new Date(a.createdAt).getTime() || 0;
            const bCreated = new Date(b.createdAt).getTime() || 0;
            const aMod = new Date(a.modifiedAt).getTime() || 0;
            const bMod = new Date(b.modifiedAt).getTime() || 0;
            switch (agentSortBy) {
                case 'modified-desc': return bMod - aMod;
                case 'modified-asc': return aMod - bMod;
                case 'created-desc': return bCreated - aCreated;
                case 'created-asc': return aCreated - bCreated;
                default: return bMod - aMod;
            }
        });
        return list;
    }, [agents, agentSortBy]);

    const handleAgentClick = (agent: DashboardAgent) => {
        loadAgentData(agent.id);
    };

    const handleBackToList = () => {
        setSelectedAgent(null);
        setStepFiles({});
        setStepResults({});
        setRunningSteps({});
        setCompletedSteps(new Set());
        setStepDocumentSelections({});
        setStepBibliographyBypass({});
        setStepCorpusDocuments({});
        setStepCorpusDocumentsLoading({});
        clearAgentSteps();
    };

    const handleStepFileUpload = (layerId: string, files: FileList | null, layer?: Layer) => {
        if (!files) return;
        const fileArray = Array.from(files);
        const hasBib = layer?.bibliography && layer.bibliography.length > 0;
        if (hasBib && layer.bibliography) {
            const bibNames = new Set<string>();
            for (const b of layer.bibliography) {
                const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                const fromName = b.name?.trim();
                if (fromPath) bibNames.add(fromPath);
                if (fromName) bibNames.add(fromName);
            }
            const isInBib = (fileName: string) =>
                Array.from(bibNames).some(bn =>
                    fileName === bn || fileName.endsWith(bn) || fileName.includes(bn)
                );
            const notInBib = fileArray.filter(f => !isInBib(f.name));
            if (notInBib.length > 0) {
                const names = notInBib.slice(0, 3).map(f => f.name).join(', ');
                const more = notInBib.length > 3 ? ` and ${notInBib.length - 3} more` : '';
                const ok = window.confirm(
                    `The following file(s) are not in the bibliography: ${names}${more}.\n\nAdd them anyway?`
                );
                if (!ok) return;
            }
        }
        setStepFiles(prev => ({ ...prev, [layerId]: fileArray }));
    };

    const toggleCompletedStepExpansion = (layerId: string) => {
        setExpandedCompletedSteps(prev => {
            const newSet = new Set(prev);
            if (newSet.has(layerId)) {
                newSet.delete(layerId);
            } else {
                newSet.add(layerId);
            }
            return newSet;
        });
    };

    const parseErrorMessage = (error: Error | string): { title: string; message: string; suggestion?: string } => {
        const errorText = typeof error === 'string' ? error : error.message;
        
        if (errorText.includes('exceeds the supported page limit') || 
            errorText.includes('exceeds.*page limit') ||
            errorText.includes('pages which exceeds') ||
            errorText.includes('1432 pages') ||
            errorText.includes('page limit of 1000')) {
            const pageMatch = errorText.match(/(\d+)\s*pages.*(?:exceeds|exceed).*(?:page\s*)?limit.*?(?:of\s*)?(\d+)/) ||
                             errorText.match(/document contains (\d+) pages.*exceeds.*limit.*?(\d+)/);
            const currentPages = pageMatch ? pageMatch[1] : 'Unknown';
            const maxPages = pageMatch ? pageMatch[2] : '1000';
            
            return {
                title: 'Document Too Large',
                message: `Your document contains ${currentPages} pages, which exceeds the maximum limit of ${maxPages} pages.`,
                suggestion: 'Please split your document into smaller files or reduce the page count to continue.'
            };
        }
        
        if (errorText.includes('INVALID_ARGUMENT') || errorText.includes('invalid format')) {
            return {
                title: 'Invalid File Format',
                message: 'The uploaded file format is not supported.',
                suggestion: 'Please ensure you are uploading a valid PDF, image, or text file.'
            };
        }
        
        if (errorText.includes('401') || errorText.includes('authentication') || errorText.includes('unauthorized')) {
            return {
                title: 'Authentication Error',
                message: 'Your session has expired or authentication failed.',
                suggestion: 'Please refresh the page and sign in again.'
            };
        }
        
        if (errorText.includes('429') || errorText.includes('rate limit') || errorText.includes('quota')) {
            return {
                title: 'Rate Limit Exceeded',
                message: 'Too many requests have been made recently.',
                suggestion: 'Please wait a few minutes before trying again.'
            };
        }
        
        return {
            title: 'Processing Error',
            message: errorText,
            suggestion: 'Please check your input and try again. If the problem persists, contact support.'
        };
    };

    const runStep = async (layer: Layer, allLayers: Layer[]) => {
        if (!selectedAgent) return;

        const layerId = layer.id;
        
        const layerIndex = allLayers.findIndex(l => l.id === layerId);
        if (layerIndex > 0) {
            const previousLayer = allLayers[layerIndex - 1];
            if (!completedSteps.has(previousLayer.id)) {
                alert(`Please complete Step ${layerIndex} (${previousLayer.name}) before running this step.`);
                return;
            }
        }

        const files = stepFiles[layerId] || [];
        const selectedCorpusId = stepCorpusIds[layerId];
        const checkedDocs = stepDocumentSelections[layerId] || [];
        // Resolve the subset to a stable file_id filter (pdf_name fallback for old
        // corpora). If the doc list can't be fetched, search the whole corpus rather
        // than send a dead filter.
        let metadataFilter: string | undefined;
        if (checkedDocs.length > 0 && selectedCorpusId) {
            const allDocs = await fetchCorpusDocsForFilter(selectedCorpusId);
            if (allDocs.length > 0) {
                const subset = resolveSubsetFilter(checkedDocs, allDocs);
                if (subset.action === 'block') {
                    alert('Selected documents are not in this corpus (metadata mismatch). Re-select the documents, or open the RAG Knowledge Manager to Verify and self-heal this corpus.');
                    return;
                }
                metadataFilter = subset.filter;
            }
        }

        if (files.length === 0 && !selectedCorpusId) {
            alert('Please upload files or select a RAG knowledge source for this step.');
            return;
        }

        setRunningSteps(prev => ({ ...prev, [layerId]: true }));

        try {
            let userMessageText = '';
            
            if (layer.userInstruction) {
                userMessageText += layer.userInstruction + '\n\n';
            }
            
            if (layer.outputType === 'code') {
                userMessageText += 'Provide code only.\n';
            }

            const messages = [{
                role: 'user',
                text: userMessageText,
            }];

            let res;

            if (selectedCorpusId) {
                console.log('🧠 [AgentsPanel] Using RAG corpus:', selectedCorpusId);
                console.log('📚 [AgentsPanel] User instruction:', layer.userInstruction ? 'Yes' : 'No');
                console.log('📎 [AgentsPanel] Files attached:', files.length);
                console.log('🤖 [AgentsPanel] Model:', layer.selectedModel || 'default');
                
                const ragSystemInstruction = [layer.userInstruction, layer.systemInstruction]
                  .filter((s): s is string => !!s && typeof s === 'string')
                  .join('\n\n') || undefined;

                res = await fetch('/api/rag/query', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        corpusId: selectedCorpusId,
                        messages,
                        systemInstruction: ragSystemInstruction,
                        model: (layer.selectedModel && isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL),
                        metadataFilter,
                    }),
                    credentials: 'include',
                });
            } else if (files.length > 0) {
                console.log('📎 [AgentsPanel] Standard query with file upload');
                const formData = new FormData();

                files.forEach((file, index) => {
                    formData.append(`file${index}`, file);
                });

                formData.append('messages', JSON.stringify(messages));
                formData.append('model', (layer.selectedModel && isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL));
                
                if (projectFolder?.projectId) {
                    formData.append('projectId', projectFolder.projectId);
                    console.log('📁 [AgentsPanel] Adding current project ID to request:', projectFolder.projectId);
                } else {
                    console.warn('⚠️ [AgentsPanel] No current project ID available for RAG processing');
                }

                res = await fetch('/api/gemini', {
                    method: 'POST',
                    mode: 'cors',
                    body: formData,
                });
            } else {
                console.log('💬 [AgentsPanel] Standard text query');
                res = await fetch('/api/gemini', {
                    method: 'POST',
                    mode: 'cors',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: (layer.selectedModel && isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL),
                        messages
                    })
                });
            }

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({ message: res.statusText }));
                throw new Error(`API error: ${res.status} - ${errorData.message || res.statusText}`);
            }

            const data = await res.json();
            const response = data.response?.trim() || '';
            const cleanedResponse = filterAIResponseSections(response);

            setStepResults(prev => ({ ...prev, [layerId]: cleanedResponse }));
            
            setCompletedSteps(prev => new Set(prev).add(layerId));
            
            sendToMainEditor(cleanedResponse, layer.name, layerId);

            try {
                const prevChainHash = getChain().at(-1)?.chain_hash ?? null;
                const prevStepOutput = layerIndex > 0 ? (stepResults[allLayers[layerIndex - 1]?.id] ?? null) : null;
                const model = layer.selectedModel && isValidModel(layer.selectedModel) ? layer.selectedModel : DEFAULT_MODEL;

                const record = await createIntegrityRecord({
                    name: layer.name,
                    previousChainHash: prevChainHash,
                    components: [
                        { type: 'user_input',          label: 'User Instruction',       value: layer.userInstruction ?? '' },
                        { type: 'system_instruction',  label: 'System Instruction',     value: layer.systemInstruction ?? null },
                        { type: 'context_dependency',  label: 'Context from Prev Step', value: prevStepOutput },
                        { type: 'rag_config',          label: 'Corpus ID',              value: selectedCorpusId ?? null },
                        { type: 'rag_config',          label: 'Selected Corpus Files',  value: checkedDocs },
                        { type: 'rag_config',          label: 'Retrieval Prompt',       value: selectedCorpusId ? userMessageText : null },
                        { type: 'model_config',        label: 'Model',                  value: model },
                        { type: 'execution_metadata',  label: 'User Email',             value: session?.user?.email ?? 'anonymous' },
                        { type: 'execution_metadata',  label: 'Timestamp',              value: new Date().toISOString() },
                        { type: 'execution_metadata',  label: 'Project ID',             value: projectFolder?.projectId ?? null },
                        { type: 'output',              label: 'Step Output',            value: response },
                    ],
                });
                appendRecord(record);
            } catch (integrityError) {
                console.warn('[Integrity] Record creation failed — step result is not affected:', integrityError);
            }

        } catch (error) {
            console.error(`❌ Error running step ${layer.name}:`, error);
            
            const parsedError = parseErrorMessage(error as Error);
            
            let errorMessage = `Failed to run step "${layer.name}".\n\n`;
            errorMessage += `${parsedError.title}: ${parsedError.message}`;
            
            if (parsedError.suggestion) {
                errorMessage += `\n\nSuggestion: ${parsedError.suggestion}`;
            }
            
            alert(errorMessage);
        } finally {
            setRunningSteps(prev => ({ ...prev, [layerId]: false }));
        }
    };

    const sendToMainEditor = (result: string, stepName: string, layerId: string) => {
        const formattedResult = `## ${stepName} Result\n\n${result}\n\n`;
        
        if (activeSection) {
            const currentSectionContent = getCurrentSectionContent();
            const newSectionContent = currentSectionContent + formattedResult;
            updateSectionContent(activeSection, newSectionContent);
        }
        
        setStepContent(layerId, formattedResult);
    };

    const extractLayers = (agentData: AgentDataUnion): Layer[] => {
        if (!agentData) return [];
        
        let extractedLayers: Layer[] = [];
        
        if ('versions' in agentData && agentData.versions && Array.isArray(agentData.versions) && agentData.currentVersion) {
            const currentVersion = agentData.versions.find(v => v.version === agentData.currentVersion);
            extractedLayers = currentVersion?.layers || [];
            console.log('📋 Canvas: Extracted from versioned agent:', {
                currentVersion: agentData.currentVersion,
                foundVersion: !!currentVersion,
                layerCount: extractedLayers.length,
                layers: extractedLayers.map(l => ({ id: l.id, name: l.name, isActive: l.isActive, type: l.type }))
            });
        }
        else if ('layers' in agentData && agentData.layers && Array.isArray(agentData.layers)) {
            extractedLayers = agentData.layers;
            console.log('📋 Canvas: Extracted from legacy agent:', {
                layerCount: extractedLayers.length,
                layers: extractedLayers.map(l => ({ id: l.id, name: l.name, isActive: l.isActive, type: l.type }))
            });
        }
        else {
            console.warn('📋 Canvas: Unknown agent format, returning empty layers array:', {
                hasVersions: !!(agentData && 'versions' in agentData && agentData.versions),
                hasLayers: !!(agentData && 'layers' in agentData && agentData.layers),
                currentVersion: agentData && 'currentVersion' in agentData ? agentData.currentVersion : undefined,
                agentData
            });
            return [];
        }
        
        return extractedLayers;
    };

    const handleCreateAgent = () => {
        if (!projectFolder?.projectId) {
            setError('Please select a project folder before creating an agent.');
            return;
        }

        if (!session?.accessToken) {
            setError('Please sign in to create an agent.');
            return;
        }

        setError(null);
        setNameModalError(null);
        setShowNameModal(true);
    };

    const handleCreateAgentWithName = async (agentName: string) => {
        setIsCreatingAgent(true);
        setNameModalError(null);

        try {
            const { createAgent } = await import('../../lib/versionUtils');
            const { createDefaultAgent } = await import('../../lib/agentLayer');

            const defaultAgent = createDefaultAgent(agentName, 'Agent created from canvas');

            console.log(`🚀 Canvas: Creating agent: ${agentName}`);
            const result = await createAgent(projectFolder!.projectId, agentName, defaultAgent);

            if (result.success && result.fileId) {
                console.log(`✅ Canvas: Agent "${agentName}" created successfully`);
                setShowNameModal(false);
                await loadAgents();
            } else if (result.success && result.fileName) {
                console.warn('Canvas: Agent created but no fileId returned');
                setShowNameModal(false);
                await loadAgents();
            } else {
                throw new Error(result.error || 'Failed to create agent');
            }

        } catch (error) {
            console.error('Canvas: Failed to create agent:', error);
            setNameModalError(`Failed to create agent: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            setIsCreatingAgent(false);
        }
    };

    if (status === 'loading') {
        return (
            <div className={`h-full flex flex-col ${theme.bg}`}>
                <div className={`p-4 ${theme.borderColor} border-b`}>
                    <div className="flex items-center gap-2">
                        <FaRobot className={theme.textPrimary} />
                        <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>AI Agents</h2>
                    </div>
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <FaSpinner className={`animate-spin ${theme.textSecondary}`} size={24} />
                    <span className={`ml-2 ${theme.textSecondary}`}>Loading session...</span>
                </div>
            </div>
        );
    }

    if (selectedAgent) {
        return (
            <div className={`h-full flex flex-col ${theme.bg}`}>
                {}
                <div className={`p-4 ${theme.borderColor} border-b`}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                            <button 
                                onClick={handleBackToList}
                                className={`p-1 rounded ${theme.buttonHover} transition-colors shrink-0`}
                            >
                                ←
                            </button>
                            <h2 className={`text-lg font-semibold ${theme.textPrimary} truncate`}>
                                {selectedAgent.name}
                            </h2>
                        </div>
                        {chainLength > 0 && (
                            <button
                                onClick={() => setShowIntegrityModal(true)}
                                title="View cryptographic integrity chain for steps run in this session"
                                className={`px-2 py-1 text-xs rounded whitespace-nowrap shrink-0 ${theme.buttonBg} ${theme.textSecondary} ${theme.buttonHover}`}
                            >
                                Cryptographic Chain ({chainLength})
                            </button>
                        )}
                    </div>
                    {selectedAgent.metadata?.description && (
                        <p className={`${theme.textSecondary} text-sm mt-1`}>
                            {selectedAgent.metadata.description}
                        </p>
                    )}
                </div>

                {}
                {showIntegrityModal && (
                    <IntegrityChainModal
                        chain={getChain()}
                        operationId="canvas"
                        operationName={selectedAgent.name}
                        onClose={() => setShowIntegrityModal(false)}
                        onSave={(opts) => saveChain({ ...opts, operationType: 'canvas-agent', projectId: projectFolder?.projectId })}
                        onList={listChains}
                        onLoad={loadChain}
                    />
                )}

                {}
                <div className="flex-1 p-4 overflow-y-auto">
                    {(() => {
                        const allLayers = extractLayers(selectedAgent);
                        
                        const activeLayers = allLayers
                            .filter(layer => {
                                const hasBasicProps = layer.id && layer.name;
                                
                                const isNotExplicitlyInactive = layer.isActive !== false;
                                
                                return hasBasicProps && isNotExplicitlyInactive;
                            })
                            .sort((a, b) => (a.order || 0) - (b.order || 0));
                        
                        console.log('📋 Canvas: Layer filtering results:', {
                            totalLayers: allLayers.length,
                            activeLayers: activeLayers.length,
                            allLayersDetails: allLayers.map(l => ({ 
                                id: l.id, 
                                name: l.name, 
                                isActive: l.isActive,
                                type: l.type,
                                order: l.order,
                                hasBasicProps: !!(l.id && l.name),
                                isNotExplicitlyInactive: l.isActive !== false
                            })),
                            filteredLayersShown: activeLayers.map(l => ({ 
                                id: l.id, 
                                name: l.name, 
                                isActive: l.isActive,
                                order: l.order 
                            }))
                        });
                        
                        if (activeLayers.length === 0) {
                            return (
                                <div className="text-center py-8">
                                    <FaRobot className={`mx-auto mb-2 ${theme.textSecondary}`} size={32} />
                                    <p className={`${theme.textSecondary} text-sm mb-2`}>
                                        This agent has no active steps to display.
                                    </p>
                                    {allLayers.length > 0 && (
                                        <details className={`${theme.textSecondary} text-xs`}>
                                            <summary className="cursor-pointer mb-2">
                                                Debug: Found {allLayers.length} layers but none passed filter
                                            </summary>
                                            <div className="text-left space-y-1 max-w-md mx-auto">
                                                {allLayers.map((layer, idx) => (
                                                    <div key={idx} className={`p-2 rounded ${theme.bg} border`}>
                                                        <div>ID: {layer.id || 'missing'}</div>
                                                        <div>Name: {layer.name || 'missing'}</div>
                                                        <div>isActive: {String(layer.isActive)}</div>
                                                        <div>Type: {layer.type || 'missing'}</div>
                                                        <div>Order: {layer.order || 'missing'}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                    )}
                                </div>
                            );
                        }
                        
                        return (
                            <div className="space-y-3 min-w-0">
                                {activeLayers.map((layer, index) => {
                                    const isStepCompleted = completedSteps.has(layer.id);
                                    const canRunStep = index === 0 || completedSteps.has(activeLayers[index - 1].id);
                                    const isExpanded = expandedCompletedSteps.has(layer.id);
                                    
                                    if (isStepCompleted && !isExpanded) {
                                        return (
                                            <div 
                                                key={layer.id} 
                                                className={`${theme.cardBg} rounded-lg p-3 border-2 border-green-500 transition-colors cursor-pointer min-w-0 overflow-hidden ${theme.buttonHover}`}
                                                onClick={() => toggleCompletedStepExpansion(layer.id)}
                                            >
                                                <div className="flex items-center justify-between gap-2 min-w-0">
                                                    <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                                                        <FaChevronRight className="flex-shrink-0" size={12} />
                                                        <h3 className={`${theme.textPrimary} font-medium text-sm truncate`} title={layer.name}>
                                                            Step {index + 1}: {layer.name}
                                                        </h3>
                                                    </div>
                                                    <span className="flex-shrink-0 px-2 py-1 text-xs rounded bg-green-500 text-white">
                                                        ✓ Completed
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    }
                                    
                                    return (
                            <div key={layer.id} className={`${theme.cardBg} rounded-lg p-4 border-2 min-w-0 overflow-hidden ${isStepCompleted ? 'border-green-500' : canRunStep ? theme.borderColor : 'border-gray-600 opacity-60'} transition-colors`}>
                                {isStepCompleted && (
                                    <div 
                                        className="flex items-center gap-2 mb-2 cursor-pointer"
                                        onClick={() => toggleCompletedStepExpansion(layer.id)}
                                    >
                                        <FaChevronDown size={12} />
                                        <span className={`${theme.textSecondary} text-xs`}>Collapse</span>
                                    </div>
                                )}
                                <div
                                    className="flex items-center justify-between gap-2 mb-3 cursor-pointer select-none min-w-0"
                                    onClick={() => setActiveStepId(layer.id)}
                                    title="Click to view this step's output in the editor"
                                >
                                    <h3 className={`${theme.textPrimary} font-medium truncate min-w-0`} title={layer.name}>
                                        Step {index + 1}: {layer.name}
                                    </h3>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                        {isStepCompleted && (
                                            <span className="px-2 py-1 text-xs rounded bg-green-500 text-white">
                                                ✓ Completed
                                            </span>
                                        )}
                                        <span className={`px-2 py-1 text-xs rounded ${theme.accentBg} text-white`}>
                                            {layer.type}
                                        </span>
                                    </div>
                                </div>
                                
                                {}
                                {layer.collection && (
                                    <div className="mb-3">
                                        <p className={`${theme.textSecondary} text-xs mb-1 font-semibold`}>Linked Collection:</p>
                                        <div className={`${theme.bg} p-2 rounded text-xs ${theme.textPrimary}`}>
                                            Collection ID: {layer.collection}
                                        </div>
                                    </div>
                                )}
                                
                                {}
                                {layer.imageUrls && layer.imageUrls.length > 0 && (
                                    <div className="mb-3">
                                        <p className={`${theme.textSecondary} text-xs mb-1 font-semibold`}>Linked Images ({layer.imageUrls.length}):</p>
                                        <div className="flex flex-wrap gap-1">
                                            {layer.imageUrls.map((url: string, idx: number) => (
                                                <span key={idx} className={`px-2 py-1 text-xs rounded ${theme.bg} ${theme.textSecondary}`}>
                                                    Image {idx + 1}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                
                                {}
                                {layer.urlContent && layer.urlContent.length > 0 && (
                                    <div className="mb-3">
                                        <p className={`${theme.textSecondary} text-xs mb-1 font-semibold`}>Linked URLs ({layer.urlContent.length}):</p>
                                        <div className="space-y-1">
                                            {layer.urlContent.map((url: string, idx: number) => (
                                                <a 
                                                    key={idx} 
                                                    href={url} 
                                                    target="_blank" 
                                                    rel="noopener noreferrer"
                                                    className={`block px-2 py-1 text-xs rounded ${theme.bg} ${theme.textPrimary} hover:underline truncate`}
                                                >
                                                    {url}
                                                </a>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {}
                                <div className="space-y-2">
                                    {}
                                    {availableCorpora.length > 0 && (
                                        <div className="space-y-1">
                                            <label className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${theme.buttonBg} ${theme.textSecondary} mb-1`}>
                                                RAG
                                            </label>
                                            <select
                                                value={stepCorpusIds[layer.id] || ''}
                                                onChange={(e) => {
                                                    const newCorpusId = e.target.value;
                                                    setStepCorpusIds(prev => ({ ...prev, [layer.id]: newCorpusId }));
                                                    setStepDocumentSelections(prev => ({ ...prev, [layer.id]: [] }));
                                                    setStepBibliographyBypass(prev => ({ ...prev, [layer.id]: false }));
                                                    if (newCorpusId) {
                                                        setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: true }));
                                                        fetch(`/api/rag/corpora/${encodeURIComponent(newCorpusId)}/documents${projectFolder?.projectId ? `?projectId=${encodeURIComponent(projectFolder.projectId)}` : ''}`, { credentials: 'include' })
                                                            .then(r => r.ok ? r.json() : null)
                                                            .then(data => {
                                                                const docs = data?.documents || [];
                                                                setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: docs }));
                                                                const hasBib = layer.bibliography && layer.bibliography.length > 0;
                                                                const bibNames = new Set<string>();
                                                                if (hasBib && layer.bibliography) {
                                                                    for (const b of layer.bibliography) {
                                                                        const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                                                                        const fromName = b.name?.trim();
                                                                        if (fromPath) bibNames.add(fromPath);
                                                                        if (fromName) bibNames.add(fromName);
                                                                    }
                                                                }
                                                                const isInBib = (pdfName: string) =>
                                                                    Array.from(bibNames).some(bn => pdfName === bn || pdfName.endsWith(bn) || pdfName.includes(bn));
                                                                const initialSelection = hasBib
                                                                    ? docs.filter((d: { pdfName: string }) => isInBib(d.pdfName)).map((d: { pdfName: string }) => d.pdfName)
                                                                    : docs.map((d: { pdfName: string }) => d.pdfName);
                                                                setStepDocumentSelections(prev => ({ ...prev, [layer.id]: initialSelection }));
                                                            })
                                                            .catch(() => { setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: [] })); })
                                                            .finally(() => { setStepCorpusDocumentsLoading(prev => ({ ...prev, [layer.id]: false })); });
                                                    } else {
                                                        setStepCorpusDocuments(prev => ({ ...prev, [layer.id]: [] }));
                                                    }
                                                }}
                                                disabled={!canRunStep}
                                                className={`w-full p-2 text-sm rounded ${theme.bg} ${theme.textPrimary} ${theme.borderColor} border ${!canRunStep ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            >
                                                <option value="">None (standard mode)</option>
                                                {availableCorpora.map((corpus) => (
                                                    <option key={corpus.id} value={corpus.id}>
                                                        {corpus.displayName}
                                                    </option>
                                                ))}
                                            </select>

                                            {}
                                            {stepCorpusIds[layer.id] && (() => {
                                                const isLoading = stepCorpusDocumentsLoading[layer.id];
                                                const liveDocs = (stepCorpusDocuments[layer.id] || []).filter(d => d.state !== 'FAILED');
                                                const checked = stepDocumentSelections[layer.id] || [];
                                                const hasBibliography = layer.bibliography && layer.bibliography.length > 0;
                                                const bibPdfNames = new Set<string>();
                                                if (hasBibliography && layer.bibliography) {
                                                    for (const b of layer.bibliography) {
                                                        const fromPath = b.path?.split(/[/\\]/).pop()?.trim();
                                                        const fromName = b.name?.trim();
                                                        if (fromPath) bibPdfNames.add(fromPath);
                                                        if (fromName) bibPdfNames.add(fromName);
                                                    }
                                                }
                                                const isInBibliography = (pdfName: string) =>
                                                    Array.from(bibPdfNames).some(
                                                        (bibName) =>
                                                            pdfName === bibName || pdfName.endsWith(bibName) || pdfName.includes(bibName)
                                                    );
                                                const bypassActive = !!stepBibliographyBypass[layer.id];
                                                const canSelectAll = !hasBibliography || bypassActive;
                                                const toggle = (name: string) => {
                                                    if (hasBibliography && !isInBibliography(name) && !bypassActive) {
                                                        const ok = window.confirm(
                                                            `"${name}" is not in the bibliography. Add it anyway? (You will then be able to select any documents.)`
                                                        );
                                                        if (!ok) return;
                                                        setStepBibliographyBypass(prev => ({ ...prev, [layer.id]: true }));
                                                    }
                                                    setStepDocumentSelections(prev => {
                                                        const cur = prev[layer.id] || [];
                                                        if (cur.includes(name)) {
                                                            return { ...prev, [layer.id]: cur.filter(n => n !== name) };
                                                        }
                                                        return { ...prev, [layer.id]: [...cur, name] };
                                                    });
                                                };
                                                const selectAll = () => {
                                                    setStepDocumentSelections(prev => ({
                                                        ...prev,
                                                        [layer.id]: liveDocs.map(d => d.pdfName),
                                                    }));
                                                };

                                                if (isLoading) {
                                                    return (
                                                        <p className={`${theme.textSecondary} text-xs mt-1`}>Loading documents…</p>
                                                    );
                                                }

                                                if (liveDocs.length === 0) {
                                                    const cid = stepCorpusIds[layer.id];
                                                    const isSharedCorpus = !availableCorpora.some(c => c.id === cid);
                                                    return (
                                                        <div className={`mt-1 rounded-md border ${theme.borderColor} ${theme.bg} px-2.5 py-2 text-xs leading-snug ${theme.textSecondary}`}>
                                                            {isSharedCorpus ? (
                                                                <>
                                                                    <span className={`font-semibold ${theme.textPrimary}`}>Shared corpus — file list not synced yet.</span><br />
                                                                    The individual files sync automatically the first time the corpus&apos;s owner opens this project. Until then this step still works — it searches the whole corpus — you just can&apos;t pick specific documents yet.
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <span className={`font-semibold ${theme.textPrimary}`}>No documents to list yet.</span><br />
                                                                    This corpus may still be indexing. You can still run this step now — it searches the whole corpus.
                                                                </>
                                                            )}
                                                        </div>
                                                    );
                                                }

                                                return (
                                                    <div>
                                                        <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                                                            <label className={`${theme.textSecondary} text-xs font-semibold`}>
                                                                Documents ({checked.length === 0 ? 'all' : `${checked.length} selected`}):
                                                            </label>
                                                            <div className="flex items-center gap-1">
                                                                {canSelectAll && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => canRunStep && selectAll()}
                                                                        disabled={!canRunStep}
                                                                        className={`text-xs ${theme.textSecondary} hover:underline ${!canRunStep ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                                    >
                                                                        Select all
                                                                    </button>
                                                                )}
                                                                {checked.length > 0 && (
                                                                    <>
                                                                        {canSelectAll && <span className={`text-xs ${theme.textSecondary}`}>·</span>}
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => setStepDocumentSelections(prev => ({ ...prev, [layer.id]: [] }))}
                                                                            className={`text-xs ${theme.textSecondary} hover:underline`}
                                                                        >
                                                                            Clear
                                                                        </button>
                                                                    </>
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div className={`max-h-36 overflow-y-auto rounded border ${theme.borderColor} ${theme.bg} p-1 space-y-0.5 text-left`}>
                                                            {liveDocs.map((d) => (
                                                                <label
                                                                    key={d.pdfName}
                                                                    className={`flex items-start justify-start gap-2 px-2 py-1 rounded cursor-pointer w-full text-left ${theme.buttonHover} ${!canRunStep ? 'opacity-50 cursor-not-allowed' : ''}`}
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={checked.includes(d.pdfName)}
                                                                        onChange={() => canRunStep && toggle(d.pdfName)}
                                                                        disabled={!canRunStep}
                                                                        className="shrink-0 accent-current mt-0.5"
                                                                    />
                                                                    <span className={`text-xs ${theme.textPrimary} flex-1 whitespace-normal break-words leading-tight text-left`} title={d.pdfName}>
                                                                        {d.pdfName}
                                                                    </span>
                                                                </label>
                                                            ))}
                                                        </div>
                                                        <p className={`${theme.textSecondary} text-xs mt-0.5 opacity-70`}>
                                                            {hasBibliography
                                                                ? bypassActive
                                                                    ? 'Any document can be selected. Use Select all to include all corpus documents.'
                                                                    : 'Limited to bibliography. Click a non-bibliography doc and confirm to unlock all.'
                                                                : 'All selected by default. Clear to search the entire corpus.'}
                                                        </p>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    )}
                                    
                                    {}
                                    {(() => {
                                        const ragActive = !!(stepCorpusIds[layer.id]);
                                        const uploadEnabled = canRunStep && !ragActive;
                                        return (
                                    <div className="flex flex-wrap gap-2">
                                        <input
                                            type="file"
                                            multiple
                                            className="hidden"
                                            id={`file-upload-${layer.id}`}
                                            onChange={(e) => handleStepFileUpload(layer.id, e.target.files, layer)}
                                            disabled={!uploadEnabled}
                                        />
                                        <label
                                            htmlFor={uploadEnabled ? `file-upload-${layer.id}` : undefined}
                                            className={`px-3 py-1 text-xs rounded ${theme.buttonBg} ${theme.textSecondary} ${uploadEnabled ? theme.buttonHover + ' cursor-pointer' : 'opacity-50 cursor-not-allowed'} transition-colors`}
                                            title={ragActive ? 'File upload is disabled when RAG corpus is selected' : undefined}
                                        >
                                            Upload Files
                                        </label>
                                        
                                        <button 
                                            onClick={() => runStep(layer, activeLayers)}
                                            disabled={runningSteps[layer.id] || !canRunStep}
                                            className={`px-3 py-1 text-xs rounded ${canRunStep ? theme.accentBg + ' text-white ' + theme.accentHover : 'bg-gray-500 text-gray-300 cursor-not-allowed'} transition-colors flex items-center gap-1 ${runningSteps[layer.id] || !canRunStep ? 'opacity-50' : ''}`}
                                        >
                                            {runningSteps[layer.id] ? (
                                                <FaSpinner className="animate-spin" size={10} />
                                            ) : (
                                                <FaPlay size={10} />
                                            )}
                                            {runningSteps[layer.id] ? 'Running...' : 'Run Step'}
                                        </button>
                                    </div>
                                        );
                                    })()}

                                    {}
                                    {stepFiles[layer.id] && stepFiles[layer.id].length > 0 && (
                                        <div className="mt-2">
                                            <p className={`${theme.textSecondary} text-xs mb-1`}>
                                                Uploaded files ({stepFiles[layer.id].length}):
                                            </p>
                                            <div className="flex flex-wrap gap-1">
                                                {stepFiles[layer.id].map((file, idx) => (
                                                    <span key={idx} className={`px-2 py-1 text-xs rounded ${theme.bg} ${theme.textSecondary}`}>
                                                        {file.name}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                                })}
                    </div>
                );
            })()}
                </div>
            </div>
        );
    }

    return (
        <div className={`h-full flex flex-col ${theme.bg}`}>
            {}
            <div className={`p-4 ${theme.borderColor} border-b`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FaRobot className={theme.textPrimary} />
                        <h2 className={`text-lg font-semibold ${theme.textPrimary}`}>AI Agents</h2>
                    </div>
                    <button 
                        onClick={loadAgents}
                        disabled={loading}
                        className={`p-1 rounded ${theme.buttonHover} transition-colors ${loading ? 'opacity-50' : ''}`}
                    >
                        {loading ? <FaSpinner className="animate-spin" size={14} /> : <FaSyncAlt size={14} />}
                    </button>
                </div>
                <div className="mt-2">
                    <select
                        value={agentSortBy}
                        onChange={(e) => setAgentSortBy(e.target.value as AgentSortBy)}
                        className={`text-xs rounded px-2 py-1 w-full ${theme.bg} ${theme.textSecondary} ${theme.borderColor} border focus:outline-none focus:ring-1`}
                    >
                        <option value="modified-desc">Modified (newest first)</option>
                        <option value="modified-asc">Modified (oldest first)</option>
                        <option value="created-desc">Created (newest first)</option>
                        <option value="created-asc">Created (oldest first)</option>
                    </select>
                </div>
            </div>

            {}
            <div className="flex-1 p-4 overflow-y-auto">
                {error && (
                    <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-lg text-sm">
                        {error}
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <FaSpinner className={`animate-spin ${theme.textSecondary}`} size={24} />
                        <span className={`ml-2 ${theme.textSecondary}`}>Loading agents...</span>
                    </div>
                ) : agents.length === 0 ? (
                    <div className="text-center py-8">
                        <FaRobot className={`mx-auto mb-2 ${theme.textSecondary}`} size={32} />
                        <p className={`${theme.textSecondary} text-sm`}>
                            {error ? 'Failed to load agents' : 'No agents found in this project'}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {sortedAgents.map((agent) => (
                            <div 
                                key={agent.id} 
                                className={`${theme.cardBg} rounded-lg p-3 cursor-pointer ${theme.buttonHover} transition-colors ${loadingAgent === agent.id ? 'opacity-50' : ''}`}
                                onClick={() => handleAgentClick(agent)}
                            >
                                <div className="flex items-center justify-between gap-2 min-w-0">
                                    <h3 className={`${theme.textPrimary} font-medium text-sm truncate`} title={agent.name}>
                                        {agent.name}
                                    </h3>
                                    {loadingAgent === agent.id ? (
                                        <FaSpinner className="animate-spin flex-shrink-0" size={12} />
                                    ) : (
                                        <FaRobot className={`${theme.textSecondary} flex-shrink-0`} size={14} />
                                    )}
                                </div>
                                {agent.description && (
                                    <p className={`${theme.textSecondary} text-xs truncate`} title={agent.description}>
                                        {agent.description}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {}
            <div className={`p-4 ${theme.borderColor} border-t`}>
                <button 
                    onClick={handleCreateAgent}
                    disabled={isCreatingAgent || !projectFolder?.projectId}
                    className={`w-full py-2 ${theme.accentBg} text-white text-sm rounded-md ${theme.accentHover} transition-colors mb-2 disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                    {isCreatingAgent ? (
                        <>
                            <FaSpinner className="inline animate-spin mr-2" />
                            Creating Agent...
                        </>
                    ) : (
                        <>
                            <FaPlus className="inline mr-2" />
                            Create New Agent
                        </>
                    )}
                </button>
                <button 
                    onClick={() => window.open('/ai-agents', '_blank')}
                    className={`w-full py-2 ${theme.buttonBg} ${theme.textSecondary} text-sm rounded-md ${theme.buttonHover} transition-colors`}
                >
                    Manage Agents
                </button>
            </div>

            {}
            {showNameModal && (
                <AgentNameModal
                    onClose={() => setShowNameModal(false)}
                    onCreateAgent={handleCreateAgentWithName}
                    isSubmitting={isCreatingAgent}
                    errorMessage={nameModalError}
                />
            )}
        </div>
    );
} 