"use client";
import { MathJaxContext } from 'better-react-mathjax';
import { useSession } from 'next-auth/react';
import Image from 'next/image';
import React, { useEffect, useRef, useState } from 'react';
import { useModels } from '../hooks/useModels';
import ReactMarkdown from 'react-markdown';
// @ts-expect-error useTable types incompatible
import { useTable } from 'react-table';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import SystemInstructionsSelector from "./SystemInstructionsSelector";
import { isPickableFile, getGoogleDriveDownloadUrl, validateFileSize, detectPdfPageCount } from '../lib/fileValidation';

import {
  FaBookOpen,
  FaChevronDown,
  FaChevronUp,
  FaCog,
  FaCopy,
  FaDownload,
  FaEye,
  FaEyeSlash,
  FaFileAlt,
  FaFileAudio,
  FaFilePdf,
  FaFileVideo,
  FaFlask,
  FaLink,
  FaPlay,
  FaSave,
  FaSpinner,
  FaTimes,
  FaUnlink
} from 'react-icons/fa';

import { FaImage as FaImageIcon } from 'react-icons/fa';
import EnhancementModal from '../ai-agents/components/EnhancementModal';
import { DEFAULT_MODEL } from '../lib/modelConfig';
import { BibliographyItem } from '../lib/types';
import '../styles/PromptChainLight.css';
import '../styles/buttons.css';
import '../styles/inputs.css';
import { useProjectState } from './ProjectStateContext';
import { SelectedPaper } from './ScientificPaperSearch';
import StepReferenceSelector, { Step } from './StepReferenceSelector';

const FIRST_NODE_ID = '1';
const MAX_LAYERS = 11;

export interface Extract {
  fileId: string;
  fileName: string;
  pageNumber: string;
  content: string;
  PDFName: string;
  collection?: number;
}

type InputUrlType = 'webpage' | 'gdrive' | 'gdoc' | 'gsheet' | 'database' | '';

export interface Layer {
  id: string;
  name: string;
  userInstruction: string;
  result?: string;
  pod: string;
  condition: string;
  isFrozen: boolean;
  keepMaster: boolean;
  collection?: number;
  outputType: 'basic' | 'code';
  selectedModel?: string;
  referencedSteps: string[];
  systemInstruction: string;
  userInput: string;
  inputUrl?: string;
  inputUrlType?: InputUrlType;
  bibliography?: BibliographyItem[];
  [key: string]: unknown;
}

export interface SelectedFile {
  id: string;
  name: string;
  mimeType: string;
  folderId: string;
  folderName: string;
}

export interface AgentChainProps {
  id: string;
  initialName: string;
  masterContext: string;
  collections: Extract[][];
  initialLayers?: Layer[];
  onNameChange?: (id: string, newName: string) => void;
  clearInstructionsTrigger: number;
  selectedFiles?: SelectedFile[];
  selectedPapers?: SelectedPaper[];
}

interface PreWithCopyProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
}

const PreWithCopy: React.FC<PreWithCopyProps> = ({ children, ...props }) => {
  const [showCopiedMessage, setShowCopiedMessage] = useState(false);

  const extractTextFromChildren = (nodes: React.ReactNode): string => {
    if (typeof nodes === 'string') {
      return nodes;
    }
    if (Array.isArray(nodes)) {
      return nodes.map(extractTextFromChildren).join('');
    }
    if (React.isValidElement(nodes) && nodes.props.children) {
      return extractTextFromChildren(nodes.props.children);
    }
    return '';
  };

  const codeContent = extractTextFromChildren(children);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeContent).then(() => {
      setShowCopiedMessage(true);
    }).catch(console.error);
  };

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (showCopiedMessage) {
      timer = setTimeout(() => {
        setShowCopiedMessage(false);
      }, 3000);
    }
    return () => clearTimeout(timer);
  }, [showCopiedMessage]);

  return (
    <div style={{ position: 'relative' }}>
      <pre {...props}>{children}</pre>
      <button
        onClick={handleCopy}
        title="Copy code"
        className="copy-code-button"
      >
        <FaCopy size={14} />
      </button>
      {showCopiedMessage && (
        <div className="copied-message">
          Copied!
        </div>
      )}
    </div>
  );
};

function parseMarkdownTable(markdown: string) {
  const lines = markdown.trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
  let bodyLines = lines.slice(2);
  if (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines = bodyLines.slice(0, -1);
  }
  const rows = bodyLines.map(line =>
    line.split('|').map(cell => cell.trim()).filter(Boolean)
  );
  return {
    headers,
    rows: rows.filter(row => row.length === headers.length)
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function InteractiveTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const data = React.useMemo(
    () => rows.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i]]))),
    [headers, rows]
  );
  const columns = React.useMemo(
    () => headers.map(h => ({ Header: h, accessor: h })),
    [headers]
  );
  const {
    getTableProps,
    getTableBodyProps,
    headerGroups,
    rows: tableRows,
    prepareRow
  }: {
    getTableProps: () => any;
    getTableBodyProps: () => any;
    headerGroups: any[];
    rows: any[];
    prepareRow: (row: any) => void;
  } = useTable({ columns, data });

  return (
    <table {...getTableProps()} className="interactive-table markdown-body">
      <thead>
        {headerGroups.map((headerGroup: any, index: number) => (
          <tr key={index} {...headerGroup.getHeaderGroupProps()}>
            {headerGroup.headers.map((column: any, colIndex: number) => (
              <th key={colIndex} {...column.getHeaderProps()}>{column.render('Header')}</th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody {...getTableBodyProps()}>
        {tableRows.map((row: any, rowIndex: number) => {
          prepareRow(row);
          return (
            <tr key={rowIndex} {...row.getRowProps()}>
              {row.cells.map((cell: any, cellIndex: number) => (
                <td key={cellIndex} {...cell.getCellProps()}>
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      components={{
                        pre: PreWithCopy,
                        table: ({ children }) => (
                          <table className="interactive-table markdown-body">
                            {children}
                          </table>
                        ) }}
                    >
                      {cell.render('Cell')}
                    </ReactMarkdown>
                  </div>
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const preprocessAgentChainMath = (text: string) =>
  text.replace(/```latex\s*\n([\s\S]+?)\n```/g, (_, f) => `$$\n${f.trim()}\n$$`);

const AGENT_CHAIN_REMARK_PLUGINS = [remarkMath, remarkGfm];

const MarkdownWithMath = React.memo(({ content }: { content: string }) => {
  const parts = React.useMemo(() => {
    const tableRegex = /((?:^\|.*\|.*\n)+)/gm;
    const result: { type: 'table' | 'text'; value: string }[] = [];
    let lastIndex = 0;
    let match;
    const text = preprocessAgentChainMath(content);
    while ((match = tableRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      result.push({ type: 'table', value: match[0] });
      lastIndex = tableRegex.lastIndex;
    }
    if (lastIndex < text.length) {
      result.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return result;
  }, [content]);

  return (
    <MathJaxContext>
      <div className="markdown-body">
        {parts.map((part, i) =>
          part.type === 'table' ? (
            (() => {
              const parsed = parseMarkdownTable(part.value);
              return parsed ? (
                <InteractiveTable key={i} headers={parsed.headers} rows={parsed.rows} />
              ) : (
                <pre key={i}>{part.value}</pre>
              );
            })()
          ) : (
            <ReactMarkdown
              key={i}
              remarkPlugins={AGENT_CHAIN_REMARK_PLUGINS}
              components={{ pre: PreWithCopy }}
            >
              {part.value}
            </ReactMarkdown>
          )
        )}
      </div>
    </MathJaxContext>
  );
});
MarkdownWithMath.displayName = 'MarkdownWithMath';

export default function AgentChain({

  id,
  initialName,
  masterContext,
  collections,
  initialLayers,
  onNameChange,
  clearInstructionsTrigger,
  selectedFiles,
  selectedPapers }: AgentChainProps) {
  const models = useModels();

  const { data: session } = useSession();
  const { token: globalToken, projectFolder } = useProjectState();
  const token = session?.accessToken || globalToken || '';

  const imageContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [agentNameLocal, setAgentNameLocal] = useState<string>(initialName);
  const [isEditingAgentName, setIsEditingAgentName] = useState<boolean>(false);
  const [layers, setLayers] = useState<Layer[]>(initialLayers ?? []);
  const [isSearching, setIsSearching] = useState(false);
  const [resultVisibility, setResultVisibility] = useState<Record<number, boolean>>({});
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [editingStep, setEditingStep] = useState<string | null>(null);
  const [viewCollectionContent, setViewCollectionContent] = useState<string | null>(null);
  const [systemInstructionVisible, setSystemInstructionVisible] = useState<Record<string, boolean>>({});
  const [inputsVisible, setInputsVisible] = useState<Record<string, boolean>>({});
  const [fileStates, setFileStates] = useState<Record<string, { files: File[], fileUrls: string[] }>>({});
  const [attachingFiles, setAttachingFiles] = useState<Record<string, boolean>>({});
  const [bibliographyHighlight, setBibliographyHighlight] = useState<Record<string, boolean>>({});

  const addPdfToBibliography = (layerId: string, fileName: string, filePath: string) => {
    console.log('📚 [AGENTCHAIN BIBLIOGRAPHY] Adding PDF to bibliography:', { layerId, fileName, filePath });
    
    const currentLayer = layers.find(layer => layer.id === layerId);
    if (currentLayer) {
      const currentBibliography = currentLayer.bibliography || [];
      
      const alreadyExists = currentBibliography.some(item => 
        item.name === fileName && item.path === filePath
      );
      
      if (!alreadyExists) {
        const newBibliographyItem: BibliographyItem = {
          name: fileName,
          path: filePath,
          type: 'file',
          description: 'Auto-added from file attachment'
        };
        
        const updatedBibliography = [...currentBibliography, newBibliographyItem];
        
        console.log('📝 [AGENTCHAIN BIBLIOGRAPHY] Added to layer bibliography:', newBibliographyItem);
        
        updateNodeField(layerId, 'bibliography', updatedBibliography);

        console.log('📂 [AGENTCHAIN BIBLIOGRAPHY] Auto-expanding inputs section to show bibliography');
        setInputsVisible(prev => ({ ...prev, [layerId]: true }));

        setBibliographyHighlight(prev => ({ ...prev, [layerId]: true }));
        
        setTimeout(() => {
          setBibliographyHighlight(prev => ({ ...prev, [layerId]: false }));
        }, 3000);
      } else {
        console.log('⚠️ [AGENTCHAIN BIBLIOGRAPHY] PDF already exists in bibliography, skipping');
      }
    }
  };

  const mathConfig = {
    config: {
      loader: { load: ['[tex]/html'] },
      tex: { inlineMath: [['$', '$']], displayMath: [['$$', '$$']] }
    },
    src: "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js",
    onError: (error: Error) => {
      console.error('❌ MathJax failed to load from jsDelivr CDN:', error);
      console.log('🔄 Consider using fallback CDN or self-hosting MathJax');
    }
  };

  const downloadFileFromGoogleDrive = async (fileId: string, fileName: string, mimeType?: string): Promise<File | null> => {
    if (!token) {
      alert('Authentication token not available. Please refresh the page and try again.');
      return null;
    }

    if (mimeType && !isPickableFile(mimeType, fileName)) {
      alert(`File "${fileName}" has an unsupported format (${mimeType}) and cannot be used with agents.`);
      return null;
    }

    try {
      const response = await fetch(getGoogleDriveDownloadUrl(fileId, mimeType), {
        headers: {
          'Authorization': `Bearer ${token}` } });

      if (!response.ok) {
        let errorMessage = `Failed to download "${fileName}"`;

        switch (response.status) {
          case 401:
            errorMessage += ': Authentication expired. Please refresh the page and try again.';
            break;
          case 403:
            errorMessage += ': Access denied. You may not have permission to download this file.';
            break;
          case 404:
            errorMessage += ': File not found. It may have been deleted or moved.';
            break;
          case 429:
            errorMessage += ': Too many requests. Please try again in a moment.';
            break;
          default:
            errorMessage += response.statusText ? `: ${response.statusText}` : ': Unknown error occurred.';
        }

        alert(errorMessage);
        console.error('Download failed:', {
          status: response.status,
          statusText: response.statusText,
          fileName,
          fileId
        });
        return null;
      }

      const blob = await response.blob();

      if (blob.size === 0) {
        alert(`File "${fileName}" appears to be empty and cannot be attached.`);
        return null;
      }

      const sizeValidation = validateFileSize(blob, fileName);
      if (!sizeValidation.isValid) {
        alert(sizeValidation.error);
        return null;
      }

      return new File([blob], fileName, { type: blob.type || mimeType || 'application/octet-stream' });
    } catch (error) {
      console.error('Error downloading file:', error);
      alert(`Network error while downloading "${fileName}". Please check your connection and try again.`);
      return null;
    }
  };

  const attachSelectedFileToStep = async (layerId: string, selectedFile: SelectedFile) => {
    const attachKey = `${layerId}-${selectedFile.id}`;

    console.log('🔗 [AGENTCHAIN PDF DEBUG] Starting file attachment:', {
      layerId,
      fileName: selectedFile.name,
      mimeType: selectedFile.mimeType,
      isPDF: selectedFile.mimeType === 'application/pdf'
    });

    try {
      setAttachingFiles(prev => ({ ...prev, [attachKey]: true }));

      const downloadedFile = await downloadFileFromGoogleDrive(selectedFile.id, selectedFile.name, selectedFile.mimeType);

      if (downloadedFile) {
        console.log('📁 [AGENTCHAIN PDF DEBUG] File downloaded successfully:', {
          name: downloadedFile.name,
          type: downloadedFile.type,
          size: downloadedFile.size,
          isPDF: downloadedFile.type === 'application/pdf'
        });

        if (downloadedFile.type === 'application/pdf') {
          const pageCount = await detectPdfPageCount(downloadedFile);
          if (pageCount > 1000) {
            alert(`File "${downloadedFile.name}" has ${pageCount} pages. PDFs with more than 1000 pages are currently not supported.`);
            setAttachingFiles(prev => ({ ...prev, [attachKey]: false }));
            return;
          }
        }

        const url = URL.createObjectURL(downloadedFile);
        console.log('🔗 [AGENTCHAIN PDF DEBUG] Blob URL created:', url);

        setFileStates(prev => {
          const newState = {
            ...prev,
            [layerId]: {
              files: [...(prev[layerId]?.files || []), downloadedFile],
              fileUrls: [...(prev[layerId]?.fileUrls || []), url]
            }
          };

          console.log('🗂️ [AGENTCHAIN PDF DEBUG] FileState updated:', {
            layerId,
            totalFiles: newState[layerId].files.length,
            fileNames: newState[layerId].files.map(f => f.name),
            fileTypes: newState[layerId].files.map(f => f.type)
          });

          return newState;
        });

        if (downloadedFile.type === 'application/pdf') {
          const pdfPath = `/PDFs/${selectedFile.name}`;
          addPdfToBibliography(layerId, selectedFile.name, pdfPath);
        }
      } else {
        console.error('❌ [AGENTCHAIN PDF DEBUG] File download failed - downloadedFile is null');
      }
    } catch (error) {
      console.error('❌ [AGENTCHAIN PDF DEBUG] Error attaching file:', error);
    } finally {
      setAttachingFiles(prev => ({ ...prev, [attachKey]: false }));
    }
  };

  const attachPaperToStep = (layerId: string, paper: SelectedPaper) => {
    const currentInput = layers.find(layer => layer.id === layerId)?.userInput || '';
    if (currentInput.includes(`**Scientific Paper: ${paper.title}**`)) {
      console.log(`[AttachAbstract] Paper "${paper.title}" already attached to layer ${layerId}`);
      return;
    }

    let abstractText = '';
    if (typeof paper.abstract === 'string') {
      abstractText = paper.abstract;
    } else if (typeof paper.abstract === 'object' && paper.abstract !== null) {
      abstractText = JSON.stringify(paper.abstract);
    } else {
      abstractText = 'No abstract available.';
    }

    const paperText = `
**Scientific Paper: ${paper.title}**

**Authors:** ${paper.authors.join(', ')}
**Publication Date:** ${paper.pubdate}
${paper.doi ? `**DOI:** ${paper.doi}` : ''}

**Abstract:**
${abstractText}

---
`;

    const newInput = currentInput ? `${currentInput}\n\n${paperText}` : paperText;

    updateNodeField(layerId, 'userInput', newInput);

    console.log(`Successfully attached abstract of "${paper.title}" to step ${layerId}`);
  };

  useEffect(() => {
  }, [clearInstructionsTrigger, id]);

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>, layerId: string) => {
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image')) {
        const blob = item.getAsFile();
        if (blob) {
          const file = new File([blob], "pasted-image.png", { type: blob.type });
          const url = URL.createObjectURL(file);
          setFileStates(prev => ({
            ...prev,
            [layerId]: {
              files: [...(prev[layerId]?.files || []), file],
              fileUrls: [...(prev[layerId]?.fileUrls || []), url]
            }
          }));
          e.preventDefault();
          break;
        }
      }
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>, layerId: string) => {
    const files = e.target.files;
    console.log(`[DEBUG] File input change - Files selected: ${files?.length || 0}`);

    if (!files || files.length === 0) return;

    const newFiles: File[] = [];
    const newUrls: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      const sizeValidation = validateFileSize(file);
      if (!sizeValidation.isValid) {
        alert(sizeValidation.error);
        continue;
      }

      if (file.type === 'application/pdf') {
        const pageCount = await detectPdfPageCount(file);
        if (pageCount > 1000) {
          alert(
            `⚠️ FILE TOO LARGE\n\n` +
            `"${file.name}" contains ${pageCount.toLocaleString()} pages.\n\n` +
            `PDFs with more than 1000 pages are currently not supported for direct attachment due to processing limits.\n\n` +
            `RECOMMENDATION: Consider splitting this PDF into smaller sections (<1000 pages each) or use RAG (Retrieval-Augmented Generation) instead.`
          );
          continue;
        }
      }

      newFiles.push(file);
      newUrls.push(URL.createObjectURL(file));
    }

    if (newFiles.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    console.log(`[DEBUG] Processing ${newFiles.length} files for layer ${layerId}`);
    newFiles.forEach((file, index) => {
      console.log(`[DEBUG] File ${index + 1}: ${file.name} (${file.type})`);
    });

    setFileStates(prev => ({
      ...prev,
      [layerId]: {
        files: [...(prev[layerId]?.files || []), ...newFiles],
        fileUrls: [...(prev[layerId]?.fileUrls || []), ...newUrls]
      }
    }));

    newFiles.forEach(file => {
      if (file.type === 'application/pdf') {
        const pdfPath = `/uploads/${file.name}`;
        addPdfToBibliography(layerId, file.name, pdfPath);
      }
    });

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileRemove = (layerId: string, fileIndex?: number) => {
    if (fileIndex !== undefined) {
      setFileStates(prev => {
        const currentState = prev[layerId];
        if (!currentState) return prev;

        const newFiles = currentState.files.filter((_, index) => index !== fileIndex);
        const newUrls = currentState.fileUrls.filter((_, index) => index !== fileIndex);

        return {
          ...prev,
          [layerId]: { files: newFiles, fileUrls: newUrls }
        };
      });
    } else {
      setFileStates(prev => ({ ...prev, [layerId]: { files: [], fileUrls: [] } }));
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleMouseEnter = (e: React.MouseEvent, text: string) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setTooltip({ text, x: rect.left, y: rect.top - 30 });
  };
  const handleMouseLeave = () => setTooltip(null);

  const updateNodeField = <K extends keyof Layer>(layerId: string, key: K, val: Layer[K]) => {
    setLayers(prevLayers => {
      const layerIndex = prevLayers.findIndex(l => l.id === layerId);
      if (layerIndex === -1) {
        console.warn(`Layer with id ${layerId} not found for update.`);
        return prevLayers;
      }

      const oldLayer = prevLayers[layerIndex];
      if (oldLayer[key] === val) {
        return prevLayers;
      }

      const newLayers = [...prevLayers];
      newLayers[layerIndex] = { ...oldLayer, [key]: val };
      return newLayers;
    });
  };

  const deleteNode = (layerId: string) => {
    if (layerId === FIRST_NODE_ID) return;
    setLayers(prev => prev.filter(l => l.id !== layerId));
    setSystemInstructionVisible(prev => {
      const newState = { ...prev };
      delete newState[layerId];
      return newState;
    });
    setInputsVisible(prev => {
      const newState = { ...prev };
      delete newState[layerId];
      return newState;
    });
  };

  const fetchCollectionContent = (n: number) => {
    const collectionIndex = n - 1;
    if (collectionIndex < 0 || collectionIndex >= collections.length) {
      console.warn(`Collection number ${n} is out of bounds.`);
      return '';
    }
    const collection = collections[collectionIndex];
    if (!collection) {
      console.warn(`Collection ${n} is undefined.`);
      return '';
    }
    return collection
      ?.map(e => `% Page ${e.pageNumber}, PDF: ${e.PDFName}\n${e.content}`)
      .join('\n') || '';
  };

  const addLayer = () => {
    if (layers.length >= MAX_LAYERS) {
      console.warn(`Maximum number of layers reached (${MAX_LAYERS}).`);
      return;
    }
    const newId = String(Date.now());
    const newLayer: Layer = {
      id: newId,
      name: `Step ${layers.length + 1}`,
      type: 'user',
      isActive: true,
      order: layers.length,
      selectedModel: DEFAULT_MODEL,
      systemInstruction: '',
      userInput: '',
      result: '',
      referencedSteps: [],
      imageUrls: [],
      urlContent: [],
      pod: '',
      userInstruction: '',
      assistantResponse: '',
      functionCall: '',
      toolCall: '',
      condition: '',
      isFrozen: false,
      keepMaster: false,
      prompt: '',
      outputType: 'basic',
      inputUrl: '',
      inputUrlType: '',
      selectedPersona: undefined,
      selectedPersonaIcon: undefined
    };
    setLayers(prev => [...prev, newLayer]);
    setSystemInstructionVisible(prev => ({ ...prev, [newId]: false }));
    setInputsVisible(prev => ({ ...prev, [newId]: false }));
  };

  const toggleResultVisibility = (i: number) =>
    setResultVisibility(v => ({ ...v, [i]: !v[i] }));

  const toggleSystemInstructionVisibility = (layerId: string) => {
    setSystemInstructionVisible(prev => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  const toggleInputsVisibility = (layerId: string) => {
    setInputsVisible(prev => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      console.log("Copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const downloadAsText = (text: string, name: string) => {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || 'result'}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download:", err);
    }
  };

  const [enhancingPrompts, setEnhancingPrompts] = useState<Record<string, boolean>>({});
  const [enhancingUserInputs, setEnhancingUserInputs] = useState<Record<string, boolean>>({});

  const [enhancementModal, setEnhancementModal] = useState<{
    isVisible: boolean;
    type: 'userInstruction' | 'userInput';
  }>({
    isVisible: false,
    type: 'userInstruction'
  });

  const [expandedPrompt, setExpandedPrompt] = useState<{ layerId: string, type: 'userInstruction' | 'userInput', content: string } | null>(null);

  const enhanceUserPrompt = async (layerId: string) => {
    const currentInstruction = layers.find(l => l.id === layerId)?.userInstruction || '';

    if (!currentInstruction.trim()) {
      alert('Please enter some text in the User Instruction field before enhancing it.');
      return;
    }

    setEnhancementModal({
      isVisible: true,
      type: 'userInstruction'
    });

    setEnhancingPrompts(prev => ({ ...prev, [layerId]: true }));

    try {
      const enhancementPrompt = `Please improve and enhance the following user instruction to make it more accurate, precise, longer, and well-defined. Break it down into smaller, clearer points when appropriate. The goal is to create a better, more structured prompt that will produce superior results from an AI model.

Original instruction:
"${currentInstruction}"

Please provide an enhanced version that:
- Is more specific and precise
- Includes clearer objectives and expected outcomes
- Breaks complex requests into smaller, manageable parts
- Uses professional and clear language
- Provides better context and guidance for the AI
- Maintains the original intent while improving clarity

Enhanced instruction:`;

      const messages = [{ role: 'user', text: enhancementPrompt }];

      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages
        })
      });

      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }

      const data = await res.json();
      const enhancedInstruction = data.response?.trim() || '';

      if (enhancedInstruction) {
        updateNodeField(layerId, 'userInstruction', enhancedInstruction);
      }
    } catch (error) {
      console.error('Error enhancing prompt:', error);
      alert('Failed to enhance prompt. Please try again.');
    } finally {
      setEnhancingPrompts(prev => ({ ...prev, [layerId]: false }));
      setEnhancementModal({
        isVisible: false,
        type: 'userInstruction'
      });
    }
  };

  const enhanceUserInputText = async (layerId: string) => {
    const currentUserInput = layers.find(l => l.id === layerId)?.userInput || '';

    if (!currentUserInput.trim()) {
      alert('Please enter some text in the User Input Text field before enhancing it.');
      return;
    }

    setEnhancementModal({
      isVisible: true,
      type: 'userInput'
    });

    setEnhancingUserInputs(prev => ({ ...prev, [layerId]: true }));

    try {
      const enhancementPrompt = `Please improve and enhance the following user input text to make it more accurate, precise, longer, and well-defined. Break it down into smaller, clearer points when appropriate. The goal is to create better, more structured content that will produce superior results when processed by an AI model.

Original input text:
"${currentUserInput}"

Please provide an enhanced version that:
- Is more specific and detailed
- Includes clearer context and background information
- Breaks complex ideas into smaller, manageable parts
- Uses professional and clear language
- Provides better structure and organization
- Maintains the original intent while improving clarity
- Adds relevant details that would help AI processing

Enhanced input text:`;

      const messages = [{ role: 'user', text: enhancementPrompt }];

      const res = await fetch('/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages
        })
      });

      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }

      const data = await res.json();
      const enhancedUserInput = data.response?.trim() || '';

      if (enhancedUserInput) {
        updateNodeField(layerId, 'userInput', enhancedUserInput);
      }
    } catch (error) {
      console.error('Error enhancing user input:', error);
      alert('Failed to enhance user input text. Please try again.');
    } finally {
      setEnhancingUserInputs(prev => ({ ...prev, [layerId]: false }));
      setEnhancementModal({
        isVisible: false,
        type: 'userInput'
      });
    }
  };

  const handleExpandTextarea = (layerId: string, type: 'userInstruction' | 'userInput') => {
    const layer = layers.find(l => l.id === layerId);
    if (!layer) return;

    const content = type === 'userInstruction' ? layer.userInstruction : layer.userInput;
    setExpandedPrompt({ layerId, type, content });
  };

  const handleSaveExpandedContent = (newContent: string) => {
    if (!expandedPrompt) return;

    const fieldKey = expandedPrompt.type === 'userInstruction' ? 'userInstruction' : 'userInput';
    updateNodeField(expandedPrompt.layerId, fieldKey, newContent);
    setExpandedPrompt(null);
  };

  const saveChainToGoogleDrive = async () => {
    if (!token) {
      alert('Please log in');
      return;
    }
    if (!projectFolder?.projectId) {
      alert('No project folder selected');
      return;
    }
    if (!agentNameLocal?.trim()) {
      alert('Please enter an agent name');
      return;
    }

    try {
      const { saveAgentWithVersioning } = await import('../lib/versionUtils');

      const timestamp = new Date().toISOString();

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const layersToSave = layers.map(({ result, ...rest }) => rest);
      const agentData = {
        name: agentNameLocal,
        layers: layersToSave,
        metadata: {
          created: timestamp,
          modified: timestamp
        }
      };

      const result = await saveAgentWithVersioning(projectFolder.projectId, agentNameLocal, agentData);

      if (result.success) {
        alert(`Saved successfully as ${result.versionId} in file: ${result.fileName}`);
      } else {
        throw new Error(result.error || 'Save failed');
      }

    } catch (err) {
      console.error("Save failed:", err);
      alert(`Save error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleChainSearch = async () => {
    if (isSearching) return;
    setIsSearching(true);
    const updatedLayers = [...layers];
    let previousStepResult: string | undefined = masterContext;

    for (let i = 0; i < updatedLayers.length; i++) {
      const node = updatedLayers[i];

      if (node.isFrozen && node.result !== undefined) {
        previousStepResult = node.result;
        continue;
      }

      let currentStepContext = '';

      if (node.collection != null && node.collection > 0) {
        const collectionContent = fetchCollectionContent(node.collection);
        if (collectionContent) {
          currentStepContext += `Collection Content:\n${collectionContent}\n\n`;
        }
      }

      if (node.referencedSteps && node.referencedSteps.length > 0) {
        currentStepContext += 'Referenced Steps Results:\n';
        node.referencedSteps.forEach(refId => {
          const ref = updatedLayers.find(l => l.id === refId);
          if (ref && ref.result != null) {
            currentStepContext += `=== ${ref.name} (Step ${ref.id}) ===\n${ref.result}\n\n`;
          } else if (!ref) {
            console.warn(`Referenced step ID ${refId} not found.`);
          } else if (ref.result === undefined) {
            console.warn(`Referenced step ID ${refId} has no result.`);
          }
        });
      } else {
        if (node.id === FIRST_NODE_ID) {
          currentStepContext += `Master Context:\n${masterContext}\n\n`;
        } else {
          currentStepContext += `Previous Step Result:\n${previousStepResult ?? ''}\n\n`;
          if (node.keepMaster) {
            currentStepContext += `Master Context:\n${masterContext}\n\n`;
          }
        }
      }

      const messages: { role: string; text: string }[] = [];
      let userMessageText = '';

      if (node.systemInstruction.trim()) {
        userMessageText += `System Instruction:\n${node.systemInstruction.trim()}\n-----\n\n`;
      }
      userMessageText += `Context:\n${currentStepContext}\n`;

      if (node.userInput.trim()) {
        userMessageText += `User Input:\n${node.userInput.trim()}\n\n`;
      }

      if (node.inputUrl && node.inputUrlType) {
        userMessageText += `URL Input (${node.inputUrlType}):\n${node.inputUrl}\n\n`;
      }

      userMessageText += `Prompt:\n${node.prompt}\n-----\n\n`;

      if (node.outputType === 'code') {
        userMessageText += 'Provide code only.\n';
      }

      messages.push({
        role: 'user',
        text: userMessageText });

      try {
        const fileState = fileStates[node.id];
        let res;
        if (fileState && fileState.files && fileState.files.length > 0) {
          const formData = new FormData();

          fileState.files.forEach((file, index) => {
            if (file && file.size > 0) {
              formData.append(`file${index}`, file);
            }
          });

          formData.append('messages', JSON.stringify(messages));
          formData.append('model', node.selectedModel || '');
          
          if (projectFolder?.projectId) {
            formData.append('projectId', projectFolder.projectId);
            console.log('📁 [AgentChain] Adding current project ID to request:', projectFolder.projectId);
          } else {
            console.warn('⚠️ [AgentChain] No current project ID available for RAG processing');
          }
          
          res = await fetch('/api/gemini', {
            method: 'POST',
            body: formData });
        } else {
          res = await fetch('/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: node.selectedModel, messages })
          });
        }

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({ message: res.statusText }));
          throw new Error(`API error: ${res.status} - ${errorData.message || res.statusText}`);
        }

        const data = await res.json();
        const resp: string = (data?.response ?? '').trim();

        updatedLayers[i] = { ...node, result: resp };
        previousStepResult = resp;

      } catch (err) {
        const errorMessage = `Error: ${err instanceof Error ? err.message : String(err)}`;
        updatedLayers[i] = { ...node, result: errorMessage };
        previousStepResult = errorMessage;
        console.error(`Error processing step ${node.id}:`, err);
      }
    }

    setLayers(updatedLayers);
    setIsSearching(false);
  };

  return (
    <MathJaxContext {...mathConfig}>
      {tooltip && (
        <div className="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.text}
        </div>
      )}
      <div className="container">
        <div className="agent-content">
          <div className="agent-header">
            <span
              className="agent-name"
              onClick={e => { e.stopPropagation(); setIsEditingAgentName(true); }}
            >
              {isEditingAgentName ? (
                <input
                  className="agent-name-input"
                  value={agentNameLocal}
                  onChange={e => setAgentNameLocal(e.target.value)}
                  onBlur={() => { setIsEditingAgentName(false); onNameChange?.(id, agentNameLocal); }}
                  onKeyDown={e => { if (e.key === 'Enter') { setIsEditingAgentName(false); onNameChange?.(id, agentNameLocal); } }}
                  autoFocus
                />
              ) : (
                <span onClick={() => setIsEditingAgentName(true)}>{agentNameLocal || "Unnamed Agent"}</span>
              )}
            </span>
            <button
              className="project-button-left"
              onClick={saveChainToGoogleDrive}
              onMouseEnter={e => handleMouseEnter(e, "Save chain")}
              onMouseLeave={handleMouseLeave}
            >
              <FaSave /> Save
            </button>
          </div>

          {layers.map((node, idx) => {
            const isResultVisible = resultVisibility[idx] ?? true;
            const prevSteps: Step[] = layers.slice(0, idx).map(l => ({ id: l.id, name: l.name }));
            const isSystemInstructionVisible = systemInstructionVisible[node.id] ?? false;
            const areInputsVisible = inputsVisible[node.id] ?? false;

            return (
              <div
                key={node.id}
                className={`node-wrapper ${isSystemInstructionVisible || areInputsVisible ? 'has-right-tab' : ''} ${isSearching ? 'agent-step-loading' : ''}`}
                style={{ position: 'relative' }}
              >
                {isSearching && (
                  <div className="agent-step-loading-overlay">
                    <div className="cube-spinner">
                      <div className="cube">
                        <div className="cube-face front"></div>
                        <div className="cube-face back"></div>
                        <div className="cube-face right"></div>
                        <div className="cube-face left"></div>
                        <div className="cube-face top"></div>
                        <div className="cube-face bottom"></div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="node-summary">
                  {editingStep === node.id ? (
                    <input
                      className="step-name-input"
                      value={node.name}
                      onChange={e => updateNodeField(node.id, 'name', e.target.value)}
                      onBlur={() => setEditingStep(null)}
                      onKeyDown={e => e.key === 'Enter' && setEditingStep(null)}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="editable-step-name"
                      onClick={() => setEditingStep(node.id)}
                    >
                      {node.name}
                    </span>
                  )}

                  <div className="agent-step-controls">
                    <select
                      className="detail-select"
                      value={node.collection ?? ''}
                      onChange={e => {
                        const c = parseInt(e.target.value, 10);
                        updateNodeField(node.id, 'collection', isNaN(c) || c === 0 ? undefined : c);
                      }}
                      onMouseEnter={e => handleMouseEnter(e, 'Select a collection')}
                      onMouseLeave={handleMouseLeave}
                    >
                      <option value="" disabled>
                        Select Collection
                      </option>
                      <option value="0">No Collection</option>
                      {collections.map((_, i) => (
                        <option key={i + 1} value={i + 1}>{`Collection ${i + 1}`}</option>
                      ))}
                    </select>
                    {node.collection != null && node.collection > 0 && collections[node.collection - 1] && (
                      <button
                        className="icon-btn"
                        onClick={() => setViewCollectionContent(fetchCollectionContent(node.collection!))}
                        onMouseEnter={e => handleMouseEnter(e, `View Collection ${node.collection}`)}
                        onMouseLeave={handleMouseLeave}
                      >
                        <FaBookOpen size={18} />
                      </button>
                    )}

                    <select
                      value={node.selectedModel || ''}
                      onChange={e => updateNodeField(node.id, 'selectedModel', e.target.value || undefined)}
                      style={{ width: '100%', padding: '4px', borderRadius: '4px', border: '1px solid #ccc' }}
                    >
                      {models.map((model) => (
                        <option key={model.value} value={model.value}>
                          {model.label}
                        </option>
                      ))}
                    </select>

                    <button
                      className={`icon-btn${node.isFrozen ? ' active' : ''}`}
                      onMouseEnter={e => handleMouseEnter(e, node.isFrozen ? 'Unfreeze this step' : 'Freeze this step')}
                      onMouseLeave={handleMouseLeave}
                      onClick={() => updateNodeField(node.id, 'isFrozen', !node.isFrozen)}
                    >
                      {node.isFrozen ? <FaLink /> : <FaUnlink />}
                    </button>

                    <button
                      className="icon-btn run-btn"
                      title="Run"
                      onClick={handleChainSearch}
                      disabled={isSearching}
                    >
                      <FaPlay />
                    </button>
                    {node.id !== FIRST_NODE_ID && (
                      <button
                        className="icon-btn delete-btn"
                        title="Delete"
                        onClick={() => deleteNode(node.id)}
                        onMouseEnter={e => handleMouseEnter(e, 'Delete this step')}
                        onMouseLeave={handleMouseLeave}
                      >
                        <FaTimes />
                      </button>
                    )}
                  </div>
                </div>

                <div className="node-details">
                  <StepReferenceSelector
                    allSteps={prevSteps}
                    selected={node.referencedSteps}
                    onChange={r => updateNodeField(node.id, 'referencedSteps', r)}
                  />

                  <div className="detail-section">
                    <button
                      className={`icon-btn system-instruction-toggle ${isSystemInstructionVisible ? 'active' : ''}`}
                      onClick={() => toggleSystemInstructionVisibility(node.id)}
                      onMouseEnter={e => handleMouseEnter(e, 'Toggle System Instruction')}
                      onMouseLeave={handleMouseLeave}
                    >
                      <FaCog size={18} />
                      <span>Agent Persona</span>
                      {isSystemInstructionVisible ? <FaChevronUp /> : <FaChevronDown />}
                    </button>
                  </div>
                  {isSystemInstructionVisible && (
                    <div className="system-instructions-container">
                      <SystemInstructionsSelector
                        onInstructionsChange={prompt => {
                          updateNodeField(node.id, 'systemInstruction', prompt);
                        }
                        }
                        currentInstruction={node.systemInstruction}
                      />
                      <textarea
                        className="detail-prompt"
                        value={node.systemInstruction}
                        onChange={e => {
                          updateNodeField(node.id, 'systemInstruction', e.target.value);
                        }
                        }
                        placeholder="(Optional) System instructions here, which will guide the model's behavior for this step. For example you can specify the tone, style, or specific tasks the model should focus on."
                        rows={4}
                      />
                      <span className="instruction-text">
                        These instructions will be included at the beginning of the user message for this step.
                      </span>
                    </div>
                  )}

                  {}
                  <label htmlFor={`userInstruction-${node.id}`}>User instruction:</label>
                  <div style={{ position: 'relative' }}>
                    <textarea
                      id={`userInstruction-${node.id}`}
                      className="detail-prompt"
                      value={node.userInstruction || ''}
                      onChange={e => updateNodeField(node.id, 'userInstruction', e.target.value)}
                      placeholder="This is the user instruction which will be sent to the model for this step. It can be a question, a task description, or any other instruction you want the model to follow. Summarize, analyze, or generate content based on this instruction."
                    />
                    {}
                    <div
                      style={{
                        position: 'absolute',
                        top: 'calc(8px + 20px + 28px)',
                        left: '96.7%',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '20px',
                        height: '20px',
                        cursor: 'pointer',
                        zIndex: 10,
                        backgroundColor: 'rgba(255, 255, 255, 0.9)',
                        fontSize: '12px',
                        fontWeight: 'bold',
                        color: '#666'
                      }}
                      onClick={() => handleExpandTextarea(node.id, 'userInstruction')}
                      title="Expand user instruction editor"
                    >
                      [ ]
                    </div>

                    {}
                    <div
                      style={{
                        position: 'absolute',
                        top: '20px',
                        left: '96.5%',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '24px',
                        height: '24px',
                        cursor: enhancingPrompts[node.id] ? 'wait' : 'pointer',
                        zIndex: 10
                      }}
                      onClick={() => !enhancingPrompts[node.id] && enhanceUserPrompt(node.id)}
                      title={enhancingPrompts[node.id] ? "Enhancing prompt..." : "Enhance this prompt with AI"}
                    >
                      {enhancingPrompts[node.id] ? (
                        <div
                          style={{
                            width: '20px',
                            height: '20px',
                            position: 'relative',
                            transformStyle: 'preserve-3d',
                            animation: 'spin3d 2s infinite linear'
                          }}
                        >
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              background: '#FFFFFF',
                              borderRadius: '3px',
                              position: 'absolute',
                              transformStyle: 'preserve-3d',
                              boxShadow: '0 0 10px rgba(255, 255, 255, 0.5)',
                              border: '1px solid rgba(0, 0, 0, 0.1)'
                            }}
                          />
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              background: '#FFFFFF',
                              borderRadius: '3px',
                              position: 'absolute',
                              transform: 'rotateY(90deg)',
                              transformStyle: 'preserve-3d',
                              boxShadow: '0 0 10px rgba(255, 255, 255, 0.5)',
                              border: '1px solid rgba(0, 0, 0, 0.1)'
                            }}
                          />
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              background: '#FFFFFF',
                              borderRadius: '3px',
                              position: 'absolute',
                              transform: 'rotateX(90deg)',
                              transformStyle: 'preserve-3d',
                              boxShadow: '0 0 10px rgba(255, 255, 255, 0.5)',
                              border: '1px solid rgba(0, 0, 0, 0.1)'
                            }}
                          />
                        </div>
                      ) : (
                        <Image
                          src="/images/dark fav private/apple-icon.png"
                          alt="Enhance prompt"
                          width={24}
                          height={24}
                          style={{
                            width: "100%",
                            height: "100%"
                          }}
                        />
                      )}
                    </div>
                  </div>
                  <span className="instruction-text">The main instruction or question for the model for this step.</span>
                  <div
                    className="test-input-heading"
                    onClick={() => toggleInputsVisibility(node.id)}
                    style={{ cursor: 'pointer' }}
                    title="Click to toggle user inputs section"
                  >
                    <FaFlask size={16} />
                    Attach Data
                    {areInputsVisible ? <FaChevronUp /> : <FaChevronDown />}
                  </div>

                  {areInputsVisible && (
                    <div className="inputs-container">
                      <div className="input-group">
                        <label htmlFor={`userinput-${node.id}`}>
                          <FaImageIcon size={16} style={{ marginRight: '8px' }} />
                          User Input Text
                        </label>
                        <div style={{ position: 'relative' }}>
                          <textarea
                            id={`userinput-${node.id}`}
                            className="detail-prompt"
                            value={node.userInput}
                            onChange={e => updateNodeField(node.id, 'userInput', e.target.value)}
                            placeholder="Enter text you want to analyze or process in this step. This input is for testing purposes and won't be saved. Can be used together with Collections and RAG."
                            rows={4}
                          />
                          {}
                          <div
                            style={{
                              position: 'absolute',
                              top: 'calc(8px + 20px + 28px)',
                              left: '96.7%',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '20px',
                              height: '20px',
                              cursor: 'pointer',
                              zIndex: 10,
                              backgroundColor: 'rgba(255, 255, 255, 0.9)',
                              fontSize: '12px',
                              fontWeight: 'bold',
                              color: '#666'
                            }}
                            onClick={() => handleExpandTextarea(node.id, 'userInput')}
                            title="Expand user input editor"
                          >
                            [ ]
                          </div>

                          {}
                          <div
                            style={{
                              position: 'absolute',
                              top: '20px',
                              left: '96.5%',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '24px',
                              height: '24px',
                              cursor: enhancingUserInputs[node.id] ? 'wait' : 'pointer',
                              zIndex: 10
                            }}
                            onClick={() => !enhancingUserInputs[node.id] && enhanceUserInputText(node.id)}
                            title={enhancingUserInputs[node.id] ? "Enhancing user input..." : "Enhance this user input with AI"}
                          >
                            {enhancingUserInputs[node.id] ? (
                              <div
                                style={{
                                  width: '20px',
                                  height: '20px',
                                  position: 'relative',
                                  transformStyle: 'preserve-3d',
                                  animation: 'spin3d 2s infinite linear'
                                }}
                              >
                                <div
                                  style={{
                                    width: '100%',
                                    height: '100%',
                                    background: '#FFFFFF',
                                    borderRadius: '3px',
                                    position: 'absolute',
                                    transformStyle: 'preserve-3d',
                                    boxShadow: '0 0 10px rgba(255, 255, 255, 0.5)',
                                    border: '1px solid rgba(0, 0, 0, 0.1)'
                                  }}
                                />
                                <div
                                  style={{
                                    width: '100%',
                                    height: '100%',
                                    background: '#FFFFFF',
                                    borderRadius: '3px',
                                    position: 'absolute',
                                    transform: 'rotateY(90deg)',
                                    transformStyle: 'preserve-3d',
                                    boxShadow: '0 0 10px rgba(255, 255, 255, 0.5)',
                                    border: '1px solid rgba(0, 0, 0, 0.1)'
                                  }}
                                />
                                <div
                                  style={{
                                    width: '100%',
                                    height: '100%',
                                    background: '#FFFFFF',
                                    borderRadius: '3px',
                                    position: 'absolute',
                                    transform: 'rotateX(90deg)',
                                    transformStyle: 'preserve-3d',
                                    boxShadow: '0 0 10px rgba(255, 255, 255, 0.5)',
                                    border: '1px solid rgba(0, 0, 0, 0.1)'
                                  }}
                                />
                              </div>
                            ) : (
                              <Image
                                src="/images/dark fav private/apple-icon.png"
                                alt="Enhance user input"
                                width={24}
                                height={24}
                                style={{
                                  width: "100%",
                                  height: "100%"
                                }}
                              />
                            )}
                          </div>
                        </div>
                        <span className="instruction-text">
                          Use this area to test how the model processes your input text. You can paste or type any content you want to analyze. This works independently and can be combined with Collections, RAG, or file inputs.
                        </span>
                      </div>

                      <div className="input-group">
                        <label>
                          <FaImageIcon size={16} style={{ marginRight: '8px' }} />
                          File Input (Image, PDF, Audio, Video)
                        </label>
                        {}
                        {(() => {
                          const fileState = fileStates[node.id];
                          if (fileState && fileState.files && fileState.files.length > 0) {
                            return (
                              <div style={{ marginBottom: '12px' }}>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: '8px' }}>
                                  {fileState.files.map((file, index) => {
                                    const fileUrl = fileState.fileUrls[index];
                                    return (
                                      <div key={index} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4, padding: 6, border: '1px solid #ddd', borderRadius: 6, backgroundColor: '#f9f9f9', minWidth: '120px' }}>
                                        {file.type.startsWith('image/') && fileUrl && (
                                          <Image src={fileUrl} alt={`File ${index + 1}`} width={32} height={32} style={{ objectFit: 'cover', borderRadius: 4 }} />
                                        )}
                                        {file.type === 'application/pdf' && (
                                          <FaFilePdf size={24} color="#d32f2f" />
                                        )}
                                        {file.type.startsWith('audio/') && (
                                          <FaFileAudio size={24} color="#1976d2" />
                                        )}
                                        {file.type.startsWith('video/') && (
                                          <FaFileVideo size={24} color="#7b1fa2" />
                                        )}
                                        {!file.type.startsWith('image/') &&
                                          !file.type.startsWith('audio/') &&
                                          !file.type.startsWith('video/') &&
                                          file.type !== 'application/pdf' && (
                                            <span style={{ fontSize: 20 }}>📄</span>
                                          )}
                                        <span style={{ fontSize: 11, maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#333' }}>{file.name}</span>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleFileRemove(node.id, index);
                                          }}
                                          style={{
                                            position: 'absolute',
                                            top: -6,
                                            right: -6,
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            backgroundColor: '#ff4444',
                                            color: 'white',
                                            border: 'none',
                                            fontSize: 12,
                                            cursor: 'pointer',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                                          }}
                                          title={`Remove ${file.name}`}
                                        >×</button>
                                      </div>
                                    );
                                  })}
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleFileRemove(node.id);
                                  }}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: '12px',
                                    backgroundColor: '#ff4444',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer'
                                  }}
                                  title="Remove all files"
                                >
                                  Remove All Files
                                </button>
                              </div>
                            );
                          }
                          return null;
                        })()}

                        {}
                        <div
                          className="image-paste-container"
                          tabIndex={0}
                          onPaste={(e) => handlePaste(e, node.id)}
                          ref={imageContainerRef}
                        >
                          <FaImageIcon size={32} className="icon-btn" />
                          <p style={{ marginTop: '12px', color: '#6c757d' }}>
                            Select multiple files using the button below
                          </p>
                          <p style={{ fontSize: '0.85rem', color: '#adb5bd', marginTop: '8px' }}>
                            Supports PNG, JPG, GIF, PDF, MP3, WAV, MP4, WEBM, and more (max 10MB each)
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              console.log('[DEBUG] Button clicked, triggering file input');
                              const input = document.createElement('input');
                              input.type = 'file';
                              input.multiple = true;
                              input.style.display = 'none';

                              console.log('[DEBUG] Created input element, multiple attribute:', input.multiple);

                              input.onchange = (e) => {
                                console.log('[DEBUG] File input change event triggered');
                                handleFileInputChange(e as unknown as React.ChangeEvent<HTMLInputElement>, node.id);
                              };

                              document.body.appendChild(input);

                              setTimeout(() => {
                                console.log('[DEBUG] Clicking file input');
                                input.click();

                                setTimeout(() => {
                                  if (document.body.contains(input)) {
                                    document.body.removeChild(input);
                                  }
                                }, 1000);
                              }, 10);
                            }}
                            style={{
                              marginTop: '12px',
                              padding: '8px 16px',
                              backgroundColor: '#007bff',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '14px'
                            }}
                          >
                            📁 Choose Multiple Files
                          </button>

                          {}
                          <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                            <strong>Alternative method (if button doesn't work):</strong>
                            <input
                              type="file"
                              multiple
                              onChange={e => handleFileInputChange(e, node.id)}
                              style={{
                                display: 'block',
                                marginTop: '4px',
                                fontSize: '12px',
                                padding: '4px'
                              }}
                            />
                          </div>
                        </div>
                        <span className="instruction-text">
                          Upload or paste multiple images, PDFs, audio, or video files to be included with this step's input. All files will be processed together with any text input.
                        </span>
                      </div>

                      {}
                      {selectedFiles && selectedFiles.length > 0 && (
                        <div className="input-group">
                          <label>
                            <FaFileAlt size={16} style={{ marginRight: '8px' }} />
                            Selected Project Files
                          </label>
                          <div className="selected-files-container">
                            {selectedFiles.map((file) => {
                              const attachKey = `${node.id}-${file.id}`;
                              const isAttaching = attachingFiles[attachKey];
                              return (
                                <div key={file.id} className="selected-file-item">
                                  <span className="file-name">{file.name}</span>
                                  <span className="file-folder">({file.folderName})</span>
                                  <button
                                    className={`attach-file-btn ${isAttaching ? 'loading' : ''}`}
                                    onClick={() => attachSelectedFileToStep(node.id, file)}
                                    disabled={isAttaching}
                                    title={isAttaching ? 'Downloading...' : `Attach ${file.name} to this step`}
                                  >
                                    {isAttaching ? (
                                      <>
                                        <FaSpinner className="spinning" size={12} style={{ marginRight: '6px' }} />
                                        Downloading...
                                      </>
                                    ) : (
                                      'Attach to Step'
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                          <span className="instruction-text">
                            Click "Attach to Step" to download and attach any of these selected project files to this step.
                          </span>
                        </div>
                      )}

                      {}
                      {selectedPapers && selectedPapers.length > 0 && (
                        <div className="input-group">
                          <label>
                            <FaBookOpen size={16} style={{ marginRight: '8px' }} />
                            Selected Scientific Papers
                          </label>
                          <div className="selected-files-container">
                            {selectedPapers.map((paper) => (
                              <div key={paper.id} className="selected-file-item">
                                <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                                  <span className="file-name" style={{ fontWeight: '600' }}>{paper.title}</span>
                                  <span className="file-folder" style={{ fontSize: '0.85rem', color: '#6b7280' }}>
                                    {paper.authors.join(', ')} ({paper.pubdate})
                                  </span>
                                  {paper.doi && (
                                    <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>DOI: {paper.doi}</span>
                                  )}
                                </div>
                                <button
                                  className="attach-file-btn"
                                  onClick={() => attachPaperToStep(node.id, paper)}
                                  title={`Attach abstract of "${paper.title}" to this step`}
                                >
                                  Attach Abstract
                                </button>
                              </div>
                            ))}
                          </div>
                          <span className="instruction-text">
                            Click "Attach Abstract" to add the paper's abstract and metadata to this step's input.
                          </span>
                        </div>
                      )}

                      {}
                      <div className="input-group">
                        <label>
                          <FaBookOpen size={16} style={{ marginRight: '8px' }} />
                          Bibliography
                          {bibliographyHighlight[node.id] && (
                            <span style={{
                              marginLeft: '8px',
                              fontSize: '0.8rem',
                              color: '#28a745',
                              fontWeight: 'bold',
                              animation: 'pulse 1.5s ease-in-out infinite'
                            }}>
                              ✨ Updated!
                            </span>
                          )}
                        </label>
                        <div style={{ 
                          border: `1px solid ${bibliographyHighlight[node.id] ? '#28a745' : '#e9ecef'}`,
                          borderRadius: '4px', 
                          padding: '8px',
                          minHeight: '40px',
                          background: bibliographyHighlight[node.id] ? '#f8fff9' : '#fff',
                          boxShadow: bibliographyHighlight[node.id] ? '0 0 8px rgba(40, 167, 69, 0.3)' : 'none',
                          transition: 'all 0.3s ease'
                        }}>
                          {node.bibliography && node.bibliography.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {node.bibliography.map((item, index) => (
                                <div
                                  key={index}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    padding: '6px 10px',
                                    border: '1px solid #e3f2fd',
                                    borderRadius: '6px',
                                    backgroundColor: '#f8f9ff',
                                    borderLeft: '4px solid #2196f3'
                                  }}
                                >
                                  <div style={{ flex: 1 }}>
                                    <div style={{ 
                                      fontWeight: '500', 
                                      color: '#1976d2',
                                      fontSize: '0.85rem'
                                    }}>
                                      📚 {item.name}
                                    </div>
                                    <div style={{ 
                                      fontSize: '0.75rem', 
                                      color: '#666',
                                      marginTop: '2px'
                                    }}>
                                      {item.path}
                                    </div>
                                    {item.type && (
                                      <div style={{ 
                                        display: 'inline-block',
                                        fontSize: '0.65rem',
                                        padding: '1px 4px',
                                        backgroundColor: '#e8f5e8',
                                        border: '1px solid #4caf50',
                                        borderRadius: '8px',
                                        color: '#2e7d32',
                                        marginTop: '3px'
                                      }}>
                                        {item.type}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span style={{ color: '#6c757d', fontSize: '0.85rem', fontStyle: 'italic' }}>
                              No bibliography items attached to this step.
                            </span>
                          )}
                          
                          {node.bibliography && node.bibliography.length > 0 && (
                            <div style={{ 
                              marginTop: '6px',
                              padding: '4px 6px',
                              backgroundColor: '#f8f9fa',
                              borderRadius: '3px',
                              fontSize: '0.7rem',
                              color: '#28a745',
                              fontWeight: '500'
                            }}>
                              ✓ {node.bibliography.length} reference{node.bibliography.length > 1 ? 's' : ''} attached
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {}

                  {node.result !== undefined && (
                    <div className="chain-result">
                      {isResultVisible && <MarkdownWithMath content={node.result} />}
                      <div className="result-actions">
                        {isResultVisible && (
                          <>
                            <button
                              className="icon-btn"
                              onClick={() => copyToClipboard(node.result!)}
                              onMouseEnter={e => handleMouseEnter(e, 'Copy entire result')}
                              onMouseLeave={handleMouseLeave}
                              title="Copy"
                            >
                              <FaCopy />
                            </button>
                            <button
                              className="icon-btn"
                              onClick={() => downloadAsText(node.result!, node.name)}
                              onMouseEnter={e => handleMouseEnter(e, 'Download result')}
                              onMouseLeave={handleMouseLeave}
                              title="Download"
                            >
                              <FaDownload />
                            </button>
                          </>
                        )}
                        <button
                          className="icon-btn"
                          onClick={() => toggleResultVisibility(idx)}
                          onMouseEnter={e => handleMouseEnter(e, isResultVisible ? 'Hide result' : 'Show result')}
                          onMouseLeave={handleMouseLeave}
                          title={isResultVisible ? 'Hide result' : 'Show result'}
                        >
                          {isResultVisible ? <FaEyeSlash /> : <FaEye />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <button onClick={addLayer} disabled={layers.length >= MAX_LAYERS} className="project-button add-button">+ Add Step</button>
        </div>
      </div>

      {}
      {expandedPrompt && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: 'var(--app-height)',
          zIndex: 9999,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          background: 'rgba(0, 0, 0, 0.4)',
          pointerEvents: 'auto'
        }}>
          <div style={{
            position: 'relative',
            background: '#fff',
            borderRadius: '15px',
            padding: '15px',
            fontSize: '0.9rem',
            width: '90%',
            maxWidth: '800px',
            height: '80%',
            maxHeight: '600px',
            display: 'flex',
            flexDirection: 'column',
            resize: 'both',
            overflow: 'auto',
            minWidth: '300px',
            minHeight: '200px'
          }}>
            {}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '10px'
            }}>
              <span style={{ fontSize: '1.1rem', fontWeight: '600' }}>
                {expandedPrompt.type === 'userInstruction' ? 'Edit User Instruction' : 'Edit User Input Text'}
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setExpandedPrompt(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '4px',
                    cursor: 'pointer',
                    fontSize: '1.1rem',
                    color: '#1e1c36'
                  }}
                  title="Close"
                >
                  ×
                </button>
              </div>
            </div>

            {}
            <div style={{ flex: 1, overflowY: 'auto', marginBottom: '10px' }}>
              <textarea
                value={expandedPrompt.content}
                onChange={(e) => setExpandedPrompt(prev => prev ? { ...prev, content: e.target.value } : null)}
                style={{
                  width: '100%',
                  height: '100%',
                  padding: '8px',
                  border: '1px solid #ccc',
                  borderRadius: '5px',
                  fontSize: '1rem',
                  lineHeight: '1.5',
                  resize: 'none',
                  outline: 'none',
                  fontFamily: 'inherit',
                  background: '#f0f0f0'
                }}
                placeholder={expandedPrompt.type === 'userInstruction'
                  ? "Enter your detailed instruction for the AI model..."
                  : "Enter the text you want to analyze or process..."
                }
                autoFocus
              />
            </div>

            {}
            <div style={{ display: 'flex', gap: '5px' }}>
              <button
                onClick={() => setExpandedPrompt(null)}
                style={{
                  padding: '8px 12px',
                  border: '1px solid #ccc',
                  borderRadius: '5px',
                  background: '#fff',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleSaveExpandedContent(expandedPrompt.content)}
                style={{
                  padding: '8px 12px',
                  border: 'none',
                  background: '#1e1c36',
                  color: '#fff',
                  borderRadius: '5px',
                  cursor: 'pointer'
                }}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {viewCollectionContent !== null && (
        <div className="modal-backdrop">
          <div className="modal-content">
            <button className="modal-close-button" onClick={() => setViewCollectionContent(null)}>Close</button>
            <div className="modal-collection-content">
              <MarkdownWithMath content={viewCollectionContent} />
            </div>
          </div>
        </div>
      )}

      {}
      <EnhancementModal
        isVisible={enhancementModal.isVisible}
        enhancementType={enhancementModal.type === 'userInstruction' ? 'prompt' : enhancementModal.type}
        onCancel={() => setEnhancementModal({ isVisible: false, type: 'userInstruction' })}
        allowCancel={false}
      />
    </MathJaxContext>
  );
}
