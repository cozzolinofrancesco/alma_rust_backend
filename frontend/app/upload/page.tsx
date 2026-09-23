"use client";

import { useSession } from "next-auth/react";
import Image from 'next/image';
import Link from 'next/link';
import Script from 'next/script';
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useModels } from '../hooks/useModels';
import { 
  FaCheck,
  FaTimes,
  FaSync,
  FaRedo,
  FaBolt,
  FaBullseye,
  FaBrain,
  FaEye,
  FaFileAlt,
  FaSearchPlus
} from 'react-icons/fa';
import Dropzone from "../components/Dropzone";
import { useProjectState } from "../components/ProjectStateContext";
import { usePageReady } from '../components/SplashScreenWrapper';
import { DEFAULT_MODEL } from '../lib/modelConfig';
import DuplicateFileModal, { FileConflict } from '../components/DuplicateFileModal';
import { scanForConflicts, filterUploadableFiles } from '../lib/duplicateFileHandler';
import { useAuthenticatedFetch } from '../hooks/useAuthenticatedFetch';
import "../styles/projectstable.css";

interface VantaEffect {
  destroy: () => void;
  resize: () => void;
}

declare global {
  interface Window {
    THREE?: unknown;
    VANTA?: {
      CLOUDS: (options: unknown) => VantaEffect;
      NET: (options: unknown) => VantaEffect;
      HALO: (options: unknown) => VantaEffect;
      CELLS: (options: unknown) => VantaEffect;
      RINGS: (options: unknown) => VantaEffect;
    };
  }
}

interface FileItem {
  id: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploadDate: string;
  lastModified: string;
  tags?: string[];
  aiDescription?: string;
}

interface FolderInfo {
  name: string;
  icon: string;
  count: number;
  color: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  createdTime?: string;
  modifiedTime?: string;
}

interface APIResponse {
  files?: DriveFile[];
  subfolders?: string[];
  folders?: string[];
  error?: string;
}

const FOLDER_CONFIG: Record<string, FolderInfo> = {
  'Config': { name: 'Config', icon: 'CFG', count: 0, color: '#6B7280' },
  'Images': { name: 'Images', icon: 'IMG', count: 0, color: '#10B981' },
  'Audio': { name: 'Audio', icon: 'AUD', count: 0, color: '#8B5CF6' },
  'Video': { name: 'Video', icon: 'VID', count: 0, color: '#EF4444' },
  'Code': { name: 'Code', icon: 'COD', count: 0, color: '#3B82F6' },
  'Docs': { name: 'Docs', icon: 'DOC', count: 0, color: '#F59E0B' },
  'PDFs': { name: 'PDFs', icon: 'PDF', count: 0, color: '#DC2626' },
  'Extracts': { name: 'Extracts', icon: 'TXT', count: 0, color: '#059669' },
  'analysis': { name: 'Analysis', icon: 'ANL', count: 0, color: '#7C3AED' },
  'Others': { name: 'Others', icon: 'OTH', count: 0, color: '#6B7280' } };

export default function UploadPage() {
    const models = useModels();
  const { data: session } = useSession();
  const { projectFolder } = useProjectState();
  const { signalPageReady } = usePageReady();
  const authenticatedFetch = useAuthenticatedFetch();
  const token = session?.accessToken || '';

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<FileItem[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [masterIndex, setMasterIndex] = useState<{
    project_id: string;
    project_name?: string;
    last_updated: string;
    total_files?: number;
    folders?: Record<string, FolderInfo>;
    search_index?: Record<string, string[]>;
    files: FileItem[];
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const [isPageReady, setIsPageReady] = useState(false);
  const [initializationSteps, setInitializationSteps] = useState({
    masterIndex: false,
    files: false,
    ui: false,
    ready: false
  });

  const [dateFilter, setDateFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<FileConflict[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const [showPdfPopup, setShowPdfPopup] = useState(false);
  const [pendingPdfFile, setPendingPdfFile] = useState<File | null>(null);
  const [pendingPdfFinalName, setPendingPdfFinalName] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(10);
  const [pdfPopupLoading, setPdfPopupLoading] = useState(false);
  const [pdfPageCount, setPdfPageCount] = useState(10);

  const [showOcrProgressPopup, setShowOcrProgressPopup] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{
    currentPage: number;
    totalPages: number;
    fileName: string;
    startTime: Date | null;
    estimatedTimeRemaining: number;
    pagesProcessed: { [page: number]: 'pending' | 'processing' | 'completed' | 'error' };
    failedPages: { [page: number]: { error: string; timestamp: Date } };
    allPagesResults: { [page: number]: { 
      status: 'success' | 'error'; 
      modelUsed?: string; 
      processingTime?: number; 
      textLength?: number; 
      error?: string; 
      timestamp?: string;
      driveId?: string;
    } };
    completedPages: number;
    errorCount: number;
    isCompleted: boolean;
  }>({
    currentPage: 0,
    totalPages: 0,
    fileName: '',
    startTime: null,
    estimatedTimeRemaining: 0,
    pagesProcessed: {},
    failedPages: {},
    allPagesResults: {},
    completedPages: 0,
    errorCount: 0,
    isCompleted: false
  });

  const [showAllPagesModal, setShowAllPagesModal] = useState(false);
  const [showFailedPagesModal, setShowFailedPagesModal] = useState(false);

  const [showModelSelectionModal, setShowModelSelectionModal] = useState(false);
  const [pendingRetryPage, setPendingRetryPage] = useState<number | null>(null);
  const [retryingPages, setRetryingPages] = useState<Set<number>>(new Set());

  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [currentSubfolder, setCurrentSubfolder] = useState<string | null>(null);
  const [subfolders, setSubfolders] = useState<Record<string, string[]>>({});
  const [subfolderFiles, setSubfolderFiles] = useState<FileItem[]>([]);

  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [fileContent, setFileContent] = useState<string>('');
  const [previewError, setPreviewError] = useState<string>('');
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [showOcrOptionsModal, setShowOcrOptionsModal] = useState(false);
  const [ocrStartPage, setOcrStartPage] = useState(1);
  const [ocrEndPage, setOcrEndPage] = useState(1);
  const [ocrOptionsLoading, setOcrOptionsLoading] = useState(false);

  const vantaRef = useRef<HTMLDivElement>(null);
  const [vantaEffect, setVantaEffect] = useState<VantaEffect | null>(null);
  const [threeLoaded, setThreeLoaded] = useState(false);
  const [vantaLoaded, setVantaLoaded] = useState(false);

  useEffect(() => {
    if (projectFolder) {
      initializePage();
    }
  }, [projectFolder]);

  useEffect(() => {
    const allStepsComplete = Object.values(initializationSteps).every(Boolean);
    setIsPageReady(allStepsComplete);

    if (allStepsComplete) {
      console.log('INFO: Upload page data fully loaded - signaling aurora to end');
      signalPageReady();
    }
  }, [initializationSteps, signalPageReady]);

  useEffect(() => {
    if (threeLoaded && vantaLoaded && vantaRef.current && !vantaEffect) {
      console.log('INFO: Initializing Vanta RINGS effect...');

      const VANTA = window.VANTA;
      const THREE = window.THREE;

      if (VANTA && VANTA.RINGS && THREE) {
        try {
          const effect = VANTA.RINGS({
            el: vantaRef.current,
            THREE: THREE,
            mouseControls: true,
            touchControls: true,
            gyroControls: false,
            minHeight: 200.00,
            minWidth: 200.00,
            scale: 1.00,
            scaleMobile: 1.00,
            backgroundColor: 0x11074a,
            color: 0x059669
          });

          setVantaEffect(effect);
          console.log('INFO: Vanta RINGS effect created successfully');
        } catch (error) {
          console.error('ERROR: Error initializing Vanta RINGS effect:', error);
        }
      } else {
        console.error('ERROR: VANTA.RINGS is not available');
      }
    }
  }, [threeLoaded, vantaLoaded, vantaEffect]);

  useEffect(() => {
    return () => {
      if (vantaEffect) {
        vantaEffect.destroy();
      }
    };
  }, [vantaEffect]);

  useEffect(() => {
    let filtered = files;

    if (searchTerm) {
      filtered = filtered.filter(file =>
        file.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        file.aiDescription?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        file.tags?.some(tag => tag.toLowerCase().includes(searchTerm.toLowerCase()))
      );
    }

    if (selectedFolder !== 'all') {
      filtered = filtered.filter(file => file.folder === selectedFolder);
    }

    if (dateFilter !== 'all') {
      const now = new Date();
      const filterDate = new Date();

      switch (dateFilter) {
        case 'today':
          filterDate.setDate(now.getDate());
          break;
        case 'week':
          filterDate.setDate(now.getDate() - 7);
          break;
        case 'month':
          filterDate.setMonth(now.getMonth() - 1);
          break;
      }

      filtered = filtered.filter(file =>
        new Date(file.uploadDate) >= filterDate
      );
    }

    if (typeFilter !== 'all') {
      filtered = filtered.filter(file => {
        switch (typeFilter) {
          case 'images': return file.type.startsWith('image/');
          case 'documents': return file.type.includes('pdf') || file.type.includes('doc');
          case 'audio': return file.type.startsWith('audio/');
          case 'video': return file.type.startsWith('video/');
          default: return true;
        }
      });
    }

    setFilteredFiles(filtered);
  }, [files, searchTerm, selectedFolder, dateFilter, typeFilter]);

  const initializePage = async () => {
    setIsPageReady(false);
    setInitializationSteps({
      masterIndex: false,
      files: false,
      ui: false,
      ready: false
    });

    try {
      const [masterIndexResult, filesResult] = await Promise.allSettled([
        loadMasterIndexTracked(),
        loadFilesTracked()
      ]);

      if (masterIndexResult.status === 'fulfilled') {
        setInitializationSteps(prev => ({ ...prev, masterIndex: true }));
      } else {
        console.error('Master index loading failed:', masterIndexResult.reason);
        setInitializationSteps(prev => ({ ...prev, masterIndex: true }));
      }

      if (filesResult.status === 'fulfilled') {
        setInitializationSteps(prev => ({ ...prev, files: true }));
      } else {
        console.error('Files loading failed:', filesResult.reason);
        setInitializationSteps(prev => ({ ...prev, files: true }));
      }

      setInitializationSteps(prev => ({ ...prev, ui: false }));

      setInitializationSteps(prev => ({ ...prev, ui: true }));

      setInitializationSteps(prev => ({ ...prev, ready: true }));

    } catch (error) {
      console.error('Page initialization failed:', error);
      setInitializationSteps({
        masterIndex: true,
        files: true,
        ui: true,
        ready: true
      });
    }
  };

  const loadMasterIndexTracked = async () => {
    return loadMasterIndex();
  };

  const loadFilesTracked = async () => {
    return loadFilesParallel();
  };

  const loadMasterIndex = async () => {
    if (!projectFolder) return;

    try {
      const response = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/Config/files`,
        {
          mode: 'cors',
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.ok) {
        const data: APIResponse = await response.json();
        const indexFile = data.files?.find((f: DriveFile) => f.name === 'master_index.json');
        if (indexFile) {
          const initialIndex = {
            project_id: projectFolder.projectId,
            project_name: projectFolder.folderName,
            last_updated: new Date().toISOString(),
            total_files: 0,
            folders: {},
            search_index: {},
            files: []
          };
          setMasterIndex(initialIndex);
          console.log('Master index initialized for project:', initialIndex.project_id);
        }
      }
    } catch (error) {
      console.error('Error loading master index:', error);
    }
  };

  const loadFiles = async () => {
    if (!projectFolder) return;

    setLoading(true);
    try {
      const folderNames = Object.keys(FOLDER_CONFIG);
      const allFiles: FileItem[] = [];

      for (const folder of folderNames) {
        try {
          const response = await fetch(
            `/api/projects/${projectFolder.projectId}/folders/${folder}/files`,
            {
              mode: 'cors',
              headers: { Authorization: `Bearer ${token}` }
            }
          );

          if (response.ok) {
            const data: APIResponse = await response.json();
            const folderFiles = data.files?.map((file: DriveFile) => ({
              id: file.id,
              name: file.name,
              size: file.size || 0,
              type: file.mimeType || 'application/octet-stream',
              folder: folder,
              uploadDate: file.createdTime || new Date().toISOString(),
              lastModified: file.modifiedTime || new Date().toISOString(),
              tags: [],
              aiDescription: ''
            })) || [];

            allFiles.push(...folderFiles);
            FOLDER_CONFIG[folder].count = folderFiles.length;
          }
        } catch (error) {
          console.error(`Error loading files from ${folder}:`, error);
        }
      }

      setFiles(allFiles);
    } catch (error) {
      console.error('Error loading files:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadFilesParallel = async () => {
    if (!projectFolder) return;

    try {
      const folderNames = Object.keys(FOLDER_CONFIG);

      const folderPromises = folderNames.map(async (folder) => {
        try {
          const response = await fetch(
            `/api/projects/${projectFolder.projectId}/folders/${folder}/files`,
            {
              mode: 'cors',
              headers: { Authorization: `Bearer ${token}` }
            }
          );

          if (response.ok) {
            const data: APIResponse = await response.json();
            const folderFiles = data.files?.map((file: DriveFile) => ({
              id: file.id,
              name: file.name,
              size: file.size || 0,
              type: file.mimeType || 'application/octet-stream',
              folder: folder,
              uploadDate: file.createdTime || new Date().toISOString(),
              lastModified: file.modifiedTime || new Date().toISOString(),
              tags: [],
              aiDescription: ''
            })) || [];

            return { folder, files: folderFiles };
          } else {
            console.warn(`Failed to load ${folder}: ${response.status}`);
            return { folder, files: [] };
          }
        } catch (error) {
          console.error(`Error loading files from ${folder}:`, error);
          return { folder, files: [] };
        }
      });

      const results = await Promise.all(folderPromises);

      const allFiles: FileItem[] = [];
      results.forEach(({ folder, files }) => {
        allFiles.push(...files);
        FOLDER_CONFIG[folder].count = files.length;
      });

      setFiles(allFiles);
    } catch (error) {
      console.error('Error loading files in parallel:', error);
      throw error;
    }
  };

  const updateMasterIndex = async (newFiles: FileItem[]) => {
    if (!projectFolder) return;

    const updatedIndex = {
      project_id: projectFolder.projectId,
      project_name: projectFolder.folderName,
      last_updated: new Date().toISOString(),
      total_files: files.length + newFiles.length,
      folders: FOLDER_CONFIG,
      search_index: generateSearchIndex([...files, ...newFiles]),
      files: [...files, ...newFiles]
    };

    try {
      const indexBlob = new Blob([JSON.stringify(updatedIndex, null, 2)], {
        type: 'application/json'
      });

      const formData = new FormData();
      formData.append('file', indexBlob, 'master_index.json');

      await fetch(
        `/api/projects/${projectFolder.projectId}/folders/Config/files`,
        {
          method: 'POST',
          mode: 'cors',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        }
      );

      setMasterIndex(updatedIndex);
      console.log('Master index updated:', updatedIndex.project_id, 'with', updatedIndex.total_files, 'files');
    } catch (error) {
      console.error('Error updating master index:', error);
    }
  };

  const generateSearchIndex = (fileList: FileItem[]) => {
    const index: Record<string, string[]> = {};

    fileList.forEach(file => {
      const words = [
        ...file.name.toLowerCase().split(/\W+/),
        ...file.folder.toLowerCase().split(/\W+/),
        ...(file.aiDescription?.toLowerCase().split(/\W+/) || []),
        ...(file.tags || [])
      ];

      words.forEach(word => {
        if (word.length > 2) {
          if (!index[word]) index[word] = [];
          if (!index[word].includes(file.id)) {
            index[word].push(file.id);
          }
        }
      });
    });

    return index;
  };

  const performUpload = useCallback(async (
    filesToUpload: File[], 
    resolvedConflicts: FileConflict[]
  ) => {
    const uploadableFiles = filterUploadableFiles(filesToUpload, resolvedConflicts);
    const newFiles: FileItem[] = [];

    for (const { file, finalName, targetFolder } of uploadableFiles) {
      try {
        const formData = new FormData();
        formData.append('file', file, finalName);

        const response = await fetch(
          `/api/projects/${projectFolder?.projectId}/folders/${targetFolder}/files`,
          {
            method: 'POST',
            mode: 'cors',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
          }
        );

        if (response.ok) {
          const responseData = await response.json();
          const uploadedFile: FileItem = {
            id: responseData.file_id || `fallback-${Date.now()}-${Math.random()}`,
            name: finalName,
            size: file.size,
            type: file.type,
            folder: targetFolder,
            uploadDate: new Date().toISOString(),
            lastModified: new Date().toISOString(),
            tags: [],
            aiDescription: ''
          };

          newFiles.push(uploadedFile);
          FOLDER_CONFIG[targetFolder].count++;
        }
      } catch (error) {
        console.error(`Error uploading ${file.name}:`, error);
      }
    }

    setFiles(prev => [...prev, ...newFiles]);
    await updateMasterIndex(newFiles);

    const uploadedCount = newFiles.length;
    const renamedCount = resolvedConflicts.filter(c => c.resolution === 'rename').length;
    const skippedCount = resolvedConflicts.filter(c => c.resolution === 'cancel').length;
    
    let message = `Upload completed: ${uploadedCount} files uploaded`;
    if (renamedCount > 0) message += `, ${renamedCount} renamed`;
    if (skippedCount > 0) message += `, ${skippedCount} skipped`;
    
    console.log(message);

    if (masterIndex) {
      console.log('Current master index has', masterIndex.files.length, 'files tracked');
    }
  }, [projectFolder, token, masterIndex]);

  const processFilesWithoutConflicts = useCallback(async (
    filesToProcess: File[], 
    resolvedConflicts: FileConflict[] = []
  ) => {
    const fileMap = new Map(resolvedConflicts.map(c => [c.file.name, c]));
    const processableFiles = filesToProcess
      .map(file => {
        const conflict = fileMap.get(file.name);
        if (conflict?.resolution === 'cancel') return null;
        
        const finalName = conflict?.resolution === 'rename' ? conflict.suggestedName : file.name;
        return { originalFile: file, finalName };
      })
      .filter(Boolean) as { originalFile: File; finalName: string }[];

    const pdfFiles = processableFiles.filter(item => item.originalFile.type.includes('pdf'));
    const nonPdfFiles = processableFiles.filter(item => !item.originalFile.type.includes('pdf'));

    if (nonPdfFiles.length > 0) {
      const nonPdfFileList = nonPdfFiles.map(item => item.originalFile);
      const nonPdfConflicts = resolvedConflicts.filter(c => !c.file.type.includes('pdf'));
      await performUpload(nonPdfFileList, nonPdfConflicts);
    }

    if (pdfFiles.length > 0) {
      const firstPdfItem = pdfFiles[0];
      setPendingPdfFile(firstPdfItem.originalFile);
      setPendingPdfFinalName(firstPdfItem.finalName);

      try {
        const pageCount = await detectPdfPageCount(firstPdfItem.originalFile);
        setPdfPageCount(pageCount);
        setStartPage(1);
        setEndPage(Math.min(10, pageCount));
      } catch (error) {
        console.warn('Failed to detect PDF page count:', error);
        setPdfPageCount(10);
        setStartPage(1);
        setEndPage(10);
      }

      setShowPdfPopup(true);

      if (pdfFiles.length > 1) {
        alert(`${pdfFiles.length} PDFs detected. Processing first one: ${pdfFiles[0].originalFile.name}`);
      }
    }
  }, [performUpload]);

  const handleConflictResolution = useCallback(async (resolvedConflicts: FileConflict[]) => {
    setDuplicateModalOpen(false);
    await processFilesWithoutConflicts(pendingFiles, resolvedConflicts);
    setPendingConflicts([]);
    setPendingFiles([]);
  }, [pendingFiles, processFilesWithoutConflicts]);

  const handleUploadCancel = useCallback(() => {
    setDuplicateModalOpen(false);
    setPendingConflicts([]);
    setPendingFiles([]);
  }, []);

  const handleFileDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!projectFolder) {
      alert('Please select a project first');
      return;
    }

    const allConflicts = scanForConflicts(acceptedFiles, files);
    
    if (allConflicts.length > 0) {
      setPendingConflicts(allConflicts);
      setPendingFiles(acceptedFiles);
      setDuplicateModalOpen(true);
      return;
    }

    await processFilesWithoutConflicts(acceptedFiles);
  }, [projectFolder, files]);

  const handlePdfUploadChoice = async (choice: 'import' | 'ocr') => {
    if (!pendingPdfFile || !projectFolder) return;

    setPdfPopupLoading(true);

    const finalFileName = pendingPdfFinalName || pendingPdfFile.name;

    try {
      const formData = new FormData();
      formData.append('file', pendingPdfFile, finalFileName);

      const response = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/PDFs/files`,
        {
          method: 'POST',
          mode: 'cors',
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        }
      );

      if (response.ok) {
        const responseData = await response.json();
        const uploadedFile: FileItem = {
          id: responseData.file_id || `fallback-${Date.now()}-${Math.random()}`,
          name: finalFileName,
          size: pendingPdfFile.size,
          type: pendingPdfFile.type,
          folder: 'PDFs',
          uploadDate: new Date().toISOString(),
          lastModified: new Date().toISOString(),
          tags: choice === 'ocr' ? ['ocr-pending'] : [],
          aiDescription: choice === 'ocr' ? 'OCR processing initiated' : 'PDF imported without OCR'
        };

        setFiles(prev => [...prev, uploadedFile]);
        FOLDER_CONFIG['PDFs'].count++;
        await updateMasterIndex([uploadedFile]);

        if (choice === 'ocr') {
          await performOCR(pendingPdfFile, startPage, endPage, finalFileName);
        }

        console.log(`PDF uploaded successfully: ${finalFileName}`);
        if (finalFileName !== pendingPdfFile.name) {
          console.log(`File renamed from "${pendingPdfFile.name}" to "${finalFileName}" to avoid conflict`);
        }
      }
    } catch (error) {
      console.error(`Error uploading PDF ${finalFileName}:`, error);
    } finally {
      setPdfPopupLoading(false);
      setShowPdfPopup(false);
      setPendingPdfFile(null);
      setPendingPdfFinalName('');
    }
  };

  const performOCR = async (file: File, startPageNum: number, endPageNum: number, storedFileName?: string) => {
    const totalPages = endPageNum - startPageNum + 1;
    const startTime = new Date();
    
    const actualFileName = storedFileName || file.name;
    
    if (storedFileName && storedFileName !== file.name) {
      console.log(`📝 OCR Filename Resolution: ${file.name} → ${actualFileName}`);
    }

    const initialPagesProcessed: { [page: number]: 'pending' | 'processing' | 'completed' | 'error' } = {};
    for (let i = startPageNum; i <= endPageNum; i++) {
      initialPagesProcessed[i] = 'pending';
    }

    setOcrProgress({
      currentPage: 0,
      totalPages,
      fileName: actualFileName,
      startTime,
      estimatedTimeRemaining: totalPages * 40,
      pagesProcessed: initialPagesProcessed,
      failedPages: {},
      allPagesResults: {},
      completedPages: 0,
      errorCount: 0,
      isCompleted: false
    });

    setShowOcrProgressPopup(true);
    setLoading(true);

    const simulationControl = { shouldStop: false };

    const processPages = async () => {
      for (let page = startPageNum; page <= endPageNum; page++) {
        if (simulationControl.shouldStop) {
          console.log(`🛑 Stopping progress simulation early at page ${page}`);
          break;
        }

        const currentPageIndex = page - startPageNum + 1;
        const remainingPages = Math.max(0, totalPages - currentPageIndex);
        setOcrProgress(prev => ({
          ...prev,
          currentPage: currentPageIndex,
          pagesProcessed: {
            ...prev.pagesProcessed,
            [page]: 'processing'
          },
          estimatedTimeRemaining: remainingPages * 40
        }));

        for (let i = 0; i < 10; i++) {
          if (simulationControl.shouldStop) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }

        if (!simulationControl.shouldStop) {
          setOcrProgress(prev => ({
            ...prev,
            pagesProcessed: {
              ...prev.pagesProcessed,
              [page]: 'completed'
            },
            estimatedTimeRemaining: Math.max(0, (totalPages - currentPageIndex) * 40)
          }));
        }
      }
    };

    try {
      processPages();

      console.log(`🚀 Starting OCR API call for ${file.name} (pages ${startPageNum}-${endPageNum})`);
      const apiStartTime = Date.now();
      
      const formData = new FormData();
      formData.append("project_id", projectFolder!.projectId);
      formData.append("pdf_file", file, file.name);
      formData.append("force_ocr", "false");
      formData.append("start_page", startPageNum.toString());
      formData.append("end_page", endPageNum.toString());
      formData.append("model", selectedModel);

      const response = await fetch(`/api/ocr`, {
        method: "POST",
        mode: 'cors',
        body: formData,
        headers: { Authorization: `Bearer ${token}` } });

      const apiEndTime = Date.now();
      console.log(`✅ OCR API completed in ${((apiEndTime - apiStartTime) / 1000).toFixed(1)}s`);
      
      simulationControl.shouldStop = true;
      
      setOcrProgress(prev => ({
        ...prev,
        currentPage: totalPages,
        estimatedTimeRemaining: 0
      }));

      if (response.ok) {
        const ocrResults = await response.json();
        const pageResults = ocrResults.results || {};
        
        const failedPages: { [page: number]: { error: string; timestamp: Date } } = {};
        const allPagesResults: { [page: number]: { 
          status: 'success' | 'error'; 
          modelUsed?: string; 
          processingTime?: number; 
          textLength?: number; 
          error?: string; 
          timestamp?: string;
          driveId?: string;
        } } = {};
        let successCount = 0;
        let errorCount = 0;
        
        for (let page = startPageNum; page <= endPageNum; page++) {
          const pageResult = pageResults[page];
          if (pageResult) {
            allPagesResults[page] = {
              status: pageResult.status,
              modelUsed: pageResult.modelUsed,
              processingTime: pageResult.processingTime,
              textLength: pageResult.textLength,
              error: pageResult.error,
              timestamp: pageResult.timestamp,
              driveId: pageResult.driveId
            };

            if (pageResult.status === 'error') {
              failedPages[page] = {
                error: pageResult.error || 'Unknown error occurred',
                timestamp: new Date(pageResult.timestamp || Date.now())
              };
              errorCount++;
            } else if (pageResult.status === 'success') {
              successCount++;
            }
          }
        }

        console.log('📊 OCR Results Summary:', {
          totalProcessed: Object.keys(allPagesResults).length,
          successCount,
          errorCount,
          allPagesResults
        });
        
        setOcrProgress(prev => {
          console.log('🔄 Setting OCR completion state:', {
            currentPage: totalPages,
            totalPages,
            isCompleted: true,
            successCount,
            errorCount
          });
          return {
            ...prev,
            currentPage: totalPages,
            estimatedTimeRemaining: 0,
            failedPages,
            allPagesResults,
            completedPages: successCount,
            errorCount,
            isCompleted: true
          };
        });

        const persistedResults = JSON.parse(localStorage.getItem('ocrAllResults') || '{}');
        if (Object.keys(allPagesResults).length > 0) {
          persistedResults[file.name] = allPagesResults;
          localStorage.setItem('ocrAllResults', JSON.stringify(persistedResults));
        }

        if (Object.keys(failedPages).length > 0) {
          const persistedFailures = JSON.parse(localStorage.getItem('ocrFailures') || '{}');
          persistedFailures[file.name] = failedPages;
          localStorage.setItem('ocrFailures', JSON.stringify(persistedFailures));
        }

        await loadFiles();

        setTimeout(() => {
          if (errorCount > 0) {
            alert(`⚠️ OCR completed for ${file.name}: ${successCount} pages succeeded, ${errorCount} pages failed. Use the buttons below to view results or retry failed pages.`);
          } else {
            alert(`✅ OCR processing completed for ${file.name}! All ${successCount} pages processed successfully. Use "View All Pages" to see detailed results.`);
          }
        }, 1000);
      } else {
        simulationControl.shouldStop = true;
        console.log(`❌ OCR API failed with status: ${response.status}`);
        
        setOcrProgress(prev => {
          const errorPages = { ...prev.pagesProcessed };
          for (let i = startPageNum; i <= endPageNum; i++) {
            if (errorPages[i] === 'pending' || errorPages[i] === 'processing') {
              errorPages[i] = 'error';
            }
          }
          return {
            ...prev,
            pagesProcessed: errorPages,
            currentPage: totalPages,
            estimatedTimeRemaining: 0,
            errorCount: endPageNum - startPageNum + 1,
            isCompleted: true
          };
        });

        setTimeout(() => {
          alert(`❌ OCR processing failed for ${file.name}. PDF was still uploaded to PDFs folder.`);
        }, 1000);
      }
    } catch (error) {
      console.error("❌ OCR request failed:", error);
      
      simulationControl.shouldStop = true;

      setOcrProgress(prev => {
        const errorPages = { ...prev.pagesProcessed };
        for (let i = startPageNum; i <= endPageNum; i++) {
          errorPages[i] = 'error';
        }
        return {
          ...prev,
          pagesProcessed: errorPages,
          currentPage: totalPages,
          estimatedTimeRemaining: 0,
          errorCount: endPageNum - startPageNum + 1,
          isCompleted: true
        };
      });

      setTimeout(() => {
        alert(`❌ OCR processing failed for ${file.name}. Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }, 1000);
    } finally {
      setLoading(false);
      simulationControl.shouldStop = true;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const formatTimeRemaining = (seconds: number) => {
    const safeSeconds = Math.max(0, Math.round(seconds));

    if (safeSeconds === 0) return "Finalizing...";

    const minutes = Math.floor(safeSeconds / 60);
    const remainingSeconds = safeSeconds % 60;

    if (minutes === 0) {
      return `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;
    } else if (remainingSeconds === 0) {
      return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    } else {
      return `${minutes}m ${remainingSeconds}s`;
    }
  };

  const retryPageWithModel = async (pageNumber: number, model: string) => {
    if (!projectFolder) {
      alert('❌ Project not available');
      return;
    }

    setRetryingPages(prev => new Set([...prev, pageNumber]));

    try {
      console.log(`🔄 Retrying page ${pageNumber} with model ${model}...`);
      
      const formData = new FormData();
      formData.append("project_id", projectFolder.projectId);
      formData.append("page_number", pageNumber.toString());
      formData.append("model", model);
      formData.append("file_name", ocrProgress.fileName);

      const response = await fetch(`/api/ocr-retry`, {
        method: "POST",
        body: formData
      });

      if (response.ok) {
        const result = await response.json();
        
        const updatedResult = {
          status: 'success' as const,
          modelUsed: result.modelUsed || model,
          processingTime: result.processingTime || 0,
          textLength: result.textLength || 0,
          timestamp: result.timestamp || new Date().toISOString(),
          driveId: result.driveId
        };

        setOcrProgress(prev => {
          const newAllPagesResults = {
            ...prev.allPagesResults,
            [pageNumber]: updatedResult
          };
          
          const newFailedPages = { ...prev.failedPages };
          delete newFailedPages[pageNumber];
          
          const successCount = Object.values(newAllPagesResults).filter(r => r.status === 'success').length;
          const errorCount = Object.values(newAllPagesResults).filter(r => r.status === 'error').length;

          return {
            ...prev,
            allPagesResults: newAllPagesResults,
            failedPages: newFailedPages,
            completedPages: successCount,
            errorCount: errorCount
          };
        });

        const persistedResults = JSON.parse(localStorage.getItem('ocrAllResults') || '{}');
        if (!persistedResults[ocrProgress.fileName]) persistedResults[ocrProgress.fileName] = {};
        persistedResults[ocrProgress.fileName][pageNumber] = updatedResult;
        localStorage.setItem('ocrAllResults', JSON.stringify(persistedResults));

        alert(`✅ Page ${pageNumber} successfully re-processed with ${model} model!`);
      } else {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      console.error('❌ Retry failed:', error);
      alert(`❌ Failed to retry page ${pageNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setRetryingPages(prev => {
        const newSet = new Set(prev);
        newSet.delete(pageNumber);
        return newSet;
      });
    }
  };

  const handleRetryClick = (pageNumber: number) => {
    setPendingRetryPage(pageNumber);
    setShowModelSelectionModal(true);
  };

  const handleModelSelection = (model: string) => {
    if (pendingRetryPage !== null) {
      retryPageWithModel(pendingRetryPage, model);
    }
    setShowModelSelectionModal(false);
    setPendingRetryPage(null);
  };

  const detectPdfPageCount = async (file: File): Promise<number> => {
    try {
      const pdfLibModule = await import('pdf-lib');
      const { PDFDocument } = pdfLibModule;

      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      return pdfDoc.getPageCount();
    } catch (error) {
      console.warn('Could not detect PDF page count:', error);
      return 10;
    }
  };

  const loadSubfolders = async (folderName: string) => {
    if (!projectFolder) return;

    console.log(`INFO: Loading subfolders for: ${folderName}`);

    try {
      const response = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/${folderName}/files`,
        {
          mode: 'cors',
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.ok) {
        const data: APIResponse = await response.json();
        console.log(`INFO: ${folderName} API response:`, data);

        if (!data.subfolders && !data.folders) {
          console.log(`INFO: Trying alternative API for ${folderName}`);
          await loadSubfoldersAlternative(folderName);
        } else {
          const subfolderNames = data.subfolders || data.folders || [];
          console.log(`INFO: Found subfolders for ${folderName}:`, subfolderNames);

          setSubfolders(prev => ({
            ...prev,
            [folderName]: subfolderNames
          }));
        }
      } else {
        console.log(`ERROR: API failed for ${folderName}, trying alternative`);
        await loadSubfoldersAlternative(folderName);
      }
    } catch (error) {
      console.error(`ERROR: Error loading subfolders for ${folderName}:`, error);
      await loadSubfoldersAlternative(folderName);
    }
  };

  const loadSubfoldersAlternative = async (folderName: string) => {
    if (!projectFolder) return;

    try {
      console.log(`INFO: Using alternative API for ${folderName}`);

      const rootResponse = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/folder_id/${projectFolder.projectId}/contents`,
        {
          mode: 'cors',
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (rootResponse.ok) {
        const rootData: APIResponse = await rootResponse.json();
        console.log(`INFO: Root contents:`, rootData?.files?.length || 0, 'items');

        const targetFolder = rootData.files?.find((item: DriveFile) =>
          item.mimeType === 'application/vnd.google-apps.folder' && item.name === folderName
        );

        if (targetFolder) {
          console.log(`INFO: Found ${folderName} folder with ID:`, targetFolder.id);

          const folderResponse = await fetch(
            `/api/projects/${projectFolder.projectId}/folders/folder_id/${targetFolder.id}/contents`,
            {
              mode: 'cors',
              headers: { Authorization: `Bearer ${token}` }
            }
          );

          if (folderResponse.ok) {
            const folderData: APIResponse = await folderResponse.json();
            console.log(`INFO: ${folderName} contents:`, folderData);

            const subfolders = folderData.files?.filter((item: DriveFile) =>
              item.mimeType === 'application/vnd.google-apps.folder'
            ).map((folder: DriveFile) => folder.name) || [];

            console.log(`INFO: Found ${subfolders.length} subfolders in ${folderName}:`, subfolders);

            setSubfolders(prev => ({
              ...prev,
              [folderName]: subfolders
            }));
          } else {
            console.log(`ERROR: Failed to get contents for ${folderName}`);
          }
        } else {
          console.log(`ERROR: Could not find ${folderName} folder in root`);
        }
      }
    } catch (error) {
      console.error(`ERROR: Error in alternative method for ${folderName}:`, error);
    }
  };

  const loadSubfolderFiles = async (folderName: string, subfolderName: string) => {
    if (!projectFolder) return;

    try {
      if (folderName === 'Extracts') {
        const rootResponse = await fetch(
          `/api/projects/${projectFolder.projectId}/folders/folder_id/${projectFolder.projectId}/contents`,
          {
            mode: 'cors',
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (rootResponse.ok) {
          const rootData: APIResponse = await rootResponse.json();
          const extractsFolder = rootData.files?.find((item: DriveFile) =>
            item.mimeType === 'application/vnd.google-apps.folder' && item.name === 'Extracts'
          );

          if (extractsFolder) {
            const extractsResponse = await fetch(
              `/api/projects/${projectFolder.projectId}/folders/folder_id/${extractsFolder.id}/contents`,
              {
                mode: 'cors',
                headers: { Authorization: `Bearer ${token}` }
              }
            );

            if (extractsResponse.ok) {
              const extractsData: APIResponse = await extractsResponse.json();
              const targetSubfolder = extractsData.files?.find((item: DriveFile) =>
                item.mimeType === 'application/vnd.google-apps.folder' && item.name === subfolderName
              );

              if (targetSubfolder) {
                const filesResponse = await fetch(
                  `/api/projects/${projectFolder.projectId}/folders/folder_id/${targetSubfolder.id}/contents`,
                  {
                    mode: 'cors',
                    headers: { Authorization: `Bearer ${token}` }
                  }
                );

                if (filesResponse.ok) {
                  const filesData: APIResponse = await filesResponse.json();
                  const files = filesData.files?.filter((item: DriveFile) => item.mimeType !== 'application/vnd.google-apps.folder') || [];

                  const formattedFiles: FileItem[] = files.map((file: DriveFile) => ({
                    id: file.id,
                    name: file.name,
                    size: file.size || 0,
                    type: file.mimeType || 'application/octet-stream',
                    folder: `${folderName}/${subfolderName}`,
                    uploadDate: file.createdTime || new Date().toISOString(),
                    lastModified: file.modifiedTime || new Date().toISOString(),
                    tags: ['extracted'],
                    aiDescription: `OCR extracted from ${subfolderName}`
                  }));

                  setSubfolderFiles(formattedFiles);
                }
              }
            }
          }
        }
      } else {
        const parentResponse = await fetch(
          `/api/projects/${projectFolder.projectId}/folders/folder_id/${projectFolder.projectId}/contents`,
          {
            mode: 'cors',
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        if (parentResponse.ok) {
          const parentData: APIResponse = await parentResponse.json();
          const parentFolder = parentData.files?.find((item: DriveFile) =>
            item.mimeType === 'application/vnd.google-apps.folder' && item.name === folderName
          );

          if (parentFolder) {
            const folderContentsResponse = await fetch(
              `/api/projects/${projectFolder.projectId}/folders/folder_id/${parentFolder.id}/contents`,
              {
                mode: 'cors',
                headers: { Authorization: `Bearer ${token}` }
              }
            );

            if (folderContentsResponse.ok) {
              const folderData: APIResponse = await folderContentsResponse.json();
              const targetSubfolder = folderData.files?.find((item: DriveFile) =>
                item.mimeType === 'application/vnd.google-apps.folder' && item.name === subfolderName
              );

              if (targetSubfolder) {
                const filesResponse = await fetch(
                  `/api/projects/${projectFolder.projectId}/folders/folder_id/${targetSubfolder.id}/contents`,
                  {
                    mode: 'cors',
                    headers: { Authorization: `Bearer ${token}` }
                  }
                );

                if (filesResponse.ok) {
                  const filesData: APIResponse = await filesResponse.json();
                  const files = filesData.files?.filter((item: DriveFile) => item.mimeType !== 'application/vnd.google-apps.folder') || [];

                  const formattedFiles: FileItem[] = files.map((file: DriveFile) => ({
                    id: file.id,
                    name: file.name,
                    size: file.size || 0,
                    type: file.mimeType || 'application/octet-stream',
                    folder: `${folderName}/${subfolderName}`,
                    uploadDate: file.createdTime || new Date().toISOString(),
                    lastModified: file.modifiedTime || new Date().toISOString(),
                    tags: [],
                    aiDescription: ''
                  }));

                  setSubfolderFiles(formattedFiles);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error loading files from ${folderName}/${subfolderName}:`, error);
    }
  };

  const handleFolderClick = (folderName: string) => {
    console.log(`INFO: Folder clicked: ${folderName}`);

    setSelectedFolder(folderName);

    if (currentFolder === folderName) {
      setCurrentFolder(null);
      setCurrentSubfolder(null);
      setSubfolderFiles([]);
    } else {
      console.log(`INFO: Loading subfolders for: ${folderName}`);
      setCurrentFolder(folderName);
      setCurrentSubfolder(null);
      setSubfolderFiles([]);
      loadSubfolders(folderName);
    }
  };

  const handleSubfolderClick = (subfolderName: string) => {
    if (currentSubfolder === subfolderName) {
      setCurrentSubfolder(null);
      setSubfolderFiles([]);
    } else {
      setCurrentSubfolder(subfolderName);
      if (currentFolder) {
        loadSubfolderFiles(currentFolder, subfolderName);
      }
    }
  };

  const handleFilePreview = async (file: FileItem) => {
    setSelectedFile(file);
    setShowPreviewModal(true);
    setLoadingPreview(true);
    setPreviewError('');
    setFileContent('');

    try {
      const isFakeId = file.id.includes('.') || file.id.startsWith('fallback-');

      if (isFakeId) {
        throw new Error(`File ID appears to be invalid (${file.id}). Please refresh the file list or re-upload this file.`);
      }

      if (file.type === 'application/vnd.google-apps.folder') {
        setPreviewError('📁 Folders cannot be previewed. Please browse the folder contents instead.');
        setLoadingPreview(false);
        return;
      } else if (file.type === 'application/vnd.google-apps.form') {
        setPreviewError('📝 Google Forms cannot be previewed in this interface.');
        setLoadingPreview(false);
        return;
      } else if (file.type === 'application/vnd.google-apps.site') {
        setPreviewError('🌐 Google Sites cannot be previewed in this interface.');
        setLoadingPreview(false);
        return;
      } else if (file.type === 'application/vnd.google-apps.map') {
        setPreviewError('🗺️ Google Maps cannot be previewed in this interface.');
        setLoadingPreview(false);
        return;
      }

      const downloadUrl = `/api/projects/${projectFolder?.projectId}/folders/${file.folder}/files/${file.id}/download`;
      const response = await authenticatedFetch(downloadUrl, {
        mode: 'cors'
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (response.status === 404) {
          throw new Error(`File not found in Google Drive. File ID: ${file.id}. This may be an old cached file - try refreshing the page.`);
        }
        throw new Error(`Failed to download file (${response.status}): ${errorText || response.statusText}`);
      }

      const responseContentType = response.headers.get('content-type') || '';
      
      if (file.type.startsWith('image/')) {
        const blob = await response.blob();
        const imageUrl = URL.createObjectURL(blob);
        setFileContent(imageUrl);
      } else if (file.type === 'application/pdf' || 
                 file.type === 'application/vnd.google-apps.document' ||
                 file.type === 'application/vnd.google-apps.drawing' ||
                 responseContentType.includes('application/pdf')) {
        const blob = await response.blob();
        const pdfUrl = URL.createObjectURL(blob);
        setFileContent(pdfUrl);
      } else if (file.type === 'application/vnd.google-apps.spreadsheet') {
        setPreviewError('📊 Google Sheets need to be downloaded to view. The file has been exported as Excel format - click the download button to open.');
      } else if (file.type === 'application/vnd.google-apps.presentation') {
        setPreviewError('📽️ Google Slides need to be downloaded to view. The file has been exported as PowerPoint format - click the download button to open.');
      } else if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                 file.type === 'application/vnd.ms-excel') {
        setPreviewError('📊 Excel files need to be downloaded to view. Click the download button to open in Excel or compatible application.');
      } else if (file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
                 file.type === 'application/vnd.ms-powerpoint') {
        setPreviewError('📽️ PowerPoint files need to be downloaded to view. Click the download button to open in PowerPoint or compatible application.');
      } else if (file.type.startsWith('text/') ||
        file.type === 'application/json' ||
        file.name.endsWith('.md') ||
        file.name.endsWith('.txt') ||
        file.name.endsWith('.json') ||
        file.name.endsWith('.csv')) {
        const text = await response.text();
        setFileContent(text);
      } else {
        setPreviewError(`Preview not supported for this file type: ${file.type}. You can download the file to view it in an appropriate application.`);
      }
    } catch (error) {
      console.error('Error previewing file:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load file content';
      setPreviewError(errorMessage);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleViewAllPages = async (folderName: string, subfolderName: string) => {
    setLoadingPreview(true);
    setPreviewError('');

    try {
      const allFiles = subfolderFiles.filter(file =>
        file.folder === `${folderName}/${subfolderName}`
      );

      const sortedFiles = allFiles.sort((a, b) => {
        const pageA = parseInt(a.name.split('.')[0]) || 0;
        const pageB = parseInt(b.name.split('.')[0]) || 0;
        return pageA - pageB;
      });

      const pageContents = await Promise.all(
        sortedFiles.map(async (file) => {
          try {
            const downloadUrl = `/api/projects/${projectFolder?.projectId}/folders/${file.folder}/files/${file.id}/download`;
            const response = await fetch(downloadUrl, {
              mode: 'cors',
              headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
              const text = await response.text();
              const pageNumber = file.name.split('.')[0];
              return `=== PAGE ${pageNumber} ===\n\n${text}\n\n`;
            }
            return '';
          } catch (error) {
            console.error(`Error loading page ${file.name}:`, error);
            return `=== PAGE ${file.name.split('.')[0]} ===\n\n[Error loading page]\n\n`;
          }
        })
      );

      const combinedContent = pageContents.join('');
      setFileContent(combinedContent);

      setSelectedFile({
        id: 'combined-' + subfolderName,
        name: `${subfolderName} - Complete Document`,
        size: combinedContent.length,
        type: 'text/plain',
        folder: `${folderName}/${subfolderName}`,
        uploadDate: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        tags: ['combined', 'extract'],
        aiDescription: `Combined document from ${sortedFiles.length} pages`
      } as FileItem);

      setShowPreviewModal(true);
    } catch (error) {
      console.error('Error creating combined document:', error);
      setPreviewError('Failed to load combined document');
    } finally {
      setLoadingPreview(false);
    }
  };

  const closePreviewModal = () => {
    setShowPreviewModal(false);
    setSelectedFile(null);
    setFileContent('');
    setPreviewError('');
    if (fileContent && fileContent.startsWith('blob:')) {
      URL.revokeObjectURL(fileContent);
    }
  };

  const handlePdfReOcr = (file: FileItem) => {
    console.log('🔄 Re-OCR button clicked for:', file.name);
    setSelectedFile(file);
    setOcrStartPage(1);
    setOcrEndPage(1);
    setShowOcrOptionsModal(true);
  };

  const handleOcrOptionsConfirm = async () => {
    if (!selectedFile || !projectFolder) return;

    setOcrOptionsLoading(true);
    try {
      console.log(`🚀 Re-OCR initiated for ${selectedFile.name} (pages ${ocrStartPage}-${ocrEndPage})`);
      
      const downloadUrl = `/api/projects/${projectFolder.projectId}/folders/${selectedFile.folder}/files/${selectedFile.id}/download`;
      const response = await authenticatedFetch(downloadUrl, {
        mode: 'cors'
      });

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      const blob = await response.blob();
      const formData = new FormData();
      formData.append('pdf_file', blob, selectedFile.name);
      formData.append('start_page', ocrStartPage.toString());
      formData.append('end_page', ocrEndPage.toString());
      formData.append('project_id', projectFolder.projectId);
      formData.append('force_ocr', 'false');
      formData.append('model', DEFAULT_MODEL);

      const ocrResponse = await fetch('/api/ocr', {
        method: 'POST',
        mode: 'cors',
        body: formData,
        headers: { Authorization: `Bearer ${token}` } });

      if (!ocrResponse.ok) {
        throw new Error(`OCR failed: ${ocrResponse.statusText}`);
      }


      const _result = await ocrResponse.text();
      console.log('✅ Re-OCR completed successfully');
      alert('Re-OCR completed successfully! The file has been re-processed.');
      
      loadFiles();
      setShowOcrOptionsModal(false);
    } catch (error) {
      console.error('❌ Error during re-OCR:', error);
      alert(`Re-OCR failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setOcrOptionsLoading(false);
    }
  };

  if (!token) {
    return (
      <div style={styles.container}>
        <p>Please sign in to access the upload manager.</p>
      </div>
    );
  }

  if (!projectFolder) {
    return (
      <div style={styles.container}>
        <p>Please select a project to manage files.</p>
      </div>
    );
  }

  if (!isPageReady) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.loadingContent}>
          <div style={styles.spinner}></div>
          <h3 style={styles.loadingTitle}>Loading Smart Media Manager</h3>
          <p style={styles.loadingSubtitle}>Project: {projectFolder.folderName}</p>

          <div style={styles.progressSteps}>
            <div style={{
              ...styles.progressStep,
              ...(initializationSteps.masterIndex ? styles.progressStepComplete : styles.progressStepActive)
            }}>
              <div style={styles.progressDot}>
                {initializationSteps.masterIndex ? <CheckIcon /> : <LoadingIcon />}
              </div>
              <span>Loading configuration</span>
            </div>

            <div style={{
              ...styles.progressStep,
              ...(initializationSteps.files ? styles.progressStepComplete :
                initializationSteps.masterIndex ? styles.progressStepActive : styles.progressStepPending)
            }}>
              <div style={styles.progressDot}>
                {initializationSteps.files ? <CheckIcon /> : <LoadingIcon />}
              </div>
              <span>Loading files and folders</span>
            </div>

            <div style={{
              ...styles.progressStep,
              ...(initializationSteps.ui ? styles.progressStepComplete :
                initializationSteps.files ? styles.progressStepActive : styles.progressStepPending)
            }}>
              <div style={styles.progressDot}>
                {initializationSteps.ui ? <CheckIcon /> : <LoadingIcon />}
              </div>
              <span>Finalizing interface rendering</span>
            </div>

            <div style={{
              ...styles.progressStep,
              ...(initializationSteps.ready ? styles.progressStepComplete :
                initializationSteps.ui ? styles.progressStepActive : styles.progressStepPending)
            }}>
              <div style={styles.progressDot}>
                {initializationSteps.ready ? <CheckIcon /> : <LoadingIcon />}
              </div>
              <span>Ready for display</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {}
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r121/three.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          console.log('INFO: Three.js loaded successfully');
          setThreeLoaded(true);
        }}
        onError={(e) => {
          console.error('ERROR: Three.js failed to load:', e);
        }}
      />

      {}
      {threeLoaded && (
        <Script
          src="https://cdn.jsdelivr.net/npm/vanta@latest/dist/vanta.rings.min.js"
          strategy="afterInteractive"
          onLoad={() => {
            console.log('INFO: Vanta.js RINGS loaded successfully');
            setVantaLoaded(true);
          }}
          onError={(e) => {
            console.error('ERROR: Vanta.js RINGS failed to load:', e);
          }}
        />
      )}

      <style jsx global>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        
        /* Responsive hero section */
        @media (max-width: 768px) {
          .hero-title {
            font-size: 2rem !important;
          }
          .hero-subtitle {
            font-size: 1rem !important;
          }
          .hero-stats {
            flex-direction: column !important;
            gap: 1rem !important;
          }
          .stat-item {
            min-width: auto !important;
            width: 100% !important;
            max-width: 200px !important;
          }
        }
        
        @media (max-width: 480px) {
          .hero-title {
            font-size: 1.75rem !important;
          }
          .hero-content {
            padding: 0 1rem !important;
          }
        }
      `}</style>

      {}
      <div ref={vantaRef} style={styles.heroSection} data-tour="upload-dropzone">
        <div className="hero-content" style={styles.heroContent}>
          <h1 className="hero-title" style={styles.heroTitle}>Smart Media Manager</h1>
          <p className="hero-subtitle" style={styles.heroSubtitle}>
            Upload, organize, and process your files with AI-powered tools
          </p>
          <div className="hero-stats" style={styles.heroStats}>
            <div className="stat-item" style={styles.statItem}>
              <span style={styles.statNumber}>{files.length}</span>
              <span style={styles.statLabel}>Files</span>
            </div>
            <div className="stat-item" style={styles.statItem}>
              <span style={styles.statNumber}>{Object.keys(FOLDER_CONFIG).length}</span>
              <span style={styles.statLabel}>Folders</span>
            </div>
          </div>
          <Link
            href="/rag-corpus"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginTop: '1.5rem',
              padding: '0.75rem 1.5rem',
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
              color: 'white',
              border: '1px solid rgba(255, 255, 255, 0.4)',
              borderRadius: '12px',
              fontSize: '0.95rem',
              fontWeight: 600,
              textDecoration: 'none',
              backdropFilter: 'blur(10px)',
              transition: 'all 0.2s ease',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)' }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.35)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.6)';
              e.currentTarget.style.transform = 'translateY(-2px)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.4)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <FaBrain size={18} />
            RAG Knowledge Manager
          </Link>
        </div>
      </div>

      {}
      <div style={styles.searchSection}>
        <div style={styles.searchBar}>
          <SearchIcon />
          <input
            type="text"
            placeholder="Search files by name, content, or tags..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={styles.searchInput}
          />
          <button
            onClick={() => setShowFilters(!showFilters)}
            style={styles.filterButton}
          >
            <FilterIcon />
            Filters
          </button>
          <button
            onClick={loadFiles}
            disabled={loading}
            title={loading ? "Loading..." : "Refresh Files"}
            style={{
              padding: '0.5rem',
              backgroundColor: 'transparent',
              color: loading ? '#9CA3AF' : '#6B7280',
              border: '1px solid #E5E7EB',
              borderRadius: '6px',
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s ease',
              width: '40px',
              height: '40px'
            }}
            onMouseOver={(e) => {
              if (!loading) {
                e.currentTarget.style.backgroundColor = '#F9FAFB';
                e.currentTarget.style.borderColor = '#D1D5DB';
                e.currentTarget.style.color = '#374151';
              }
            }}
            onMouseOut={(e) => {
              if (!loading) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.borderColor = '#E5E7EB';
                e.currentTarget.style.color = '#6B7280';
              }
            }}
          >
            {loading ? (
              <div style={{
                width: '16px',
                height: '16px',
                border: '2px solid #E5E7EB',
                borderTop: '2px solid #9CA3AF',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite'
              }}></div>
            ) : (
              <RefreshIcon />
            )}
          </button>
        </div>

        {showFilters && (
          <div style={styles.filterPanel}>
            <div style={styles.filterGroup}>
              <label>Date:</label>
              <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
                <option value="all">All time</option>
                <option value="today">Today</option>
                <option value="week">Past week</option>
                <option value="month">Past month</option>
              </select>
            </div>

            <div style={styles.filterGroup}>
              <label>Type:</label>
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="all">All types</option>
                <option value="images">Images</option>
                <option value="documents">Documents</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div style={styles.mainContent}>
        {}
        <div style={styles.sidebar}>
          <div style={styles.uploadSection}>
            <Dropzone onDrop={handleFileDrop} />
          </div>

          <div style={styles.folderList}>
            <h3 style={styles.sidebarTitle}>Folders</h3>

            <div
              style={{
                ...styles.folderItem,
                ...(selectedFolder === 'all' ? styles.folderItemActive : {})
              }}
              onClick={() => setSelectedFolder('all')}
            >
              <FolderIcon />
              <span>All Files ({files.length})</span>
            </div>

            {Object.entries(FOLDER_CONFIG).map(([key, folder]) => (
              <div key={key}>
                <div
                  style={{
                    ...styles.folderItem,
                    ...(selectedFolder === key ? styles.folderItemActive : {}),
                    ...(currentFolder === key ? { backgroundColor: '#F0F4FC', borderLeft: '3px solid #059669' } : {})
                  }}
                  onClick={() => handleFolderClick(key)}
                >
                  <span style={{
                    marginRight: '8px',
                    backgroundColor: folder.color + '20',
                    color: folder.color,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    fontFamily: 'monospace'
                  }}>
                    {folder.icon}
                  </span>
                  <span>{folder.name} ({folder.count})</span>
                  {(subfolders[key] && subfolders[key].length > 0) && (
                    <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6B7280' }}>
                      {currentFolder === key ? '▼' : '▶'} {subfolders[key].length}
                    </span>
                  )}
                </div>

                {}
                {currentFolder === key && subfolders[key] && (
                  <div style={styles.subfolderList}>
                    {subfolders[key].map((subfolder) => (
                      <div
                        key={subfolder}
                        style={{
                          ...styles.subfolderItem,
                          ...(currentSubfolder === subfolder ? styles.subfolderItemActive : {})
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSubfolderClick(subfolder);
                        }}
                      >
                        <span style={{
                          marginRight: '8px',
                          backgroundColor: '#F3F4F6',
                          color: '#6B7280',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: '600'
                        }}>
                          DIR
                        </span>
                        <span>{subfolder}</span>
                        {currentSubfolder === subfolder && (
                          <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6B7280' }}>
                            {subfolderFiles.length} files
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

        </div>

        {}
        <div style={styles.content}>
          {loading ? (
            <div style={styles.loading}>
              <div style={styles.spinner}></div>
              <p>Loading files...</p>
            </div>
          ) : currentSubfolder && subfolderFiles.length > 0 ? (
            <div style={styles.searchResults}>
              <h3>{currentFolder} / {currentSubfolder}</h3>
              <p style={{ marginBottom: '1rem', color: '#6B7280' }}>
                {subfolderFiles.length} extracted files
              </p>

              {}
              {currentFolder === 'Extracts' && (
                <div style={{ marginBottom: '1rem' }}>
                  <button
                    onClick={() => handleViewAllPages(currentFolder, currentSubfolder)}
                    style={{
                      padding: '0.75rem 1.5rem',
                      backgroundColor: '#059669',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: '500',
                      transition: 'all 0.2s ease',
                      marginRight: '1rem'
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.backgroundColor = '#047857';
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.backgroundColor = '#059669';
                    }}
                  >
                    View Complete Document
                  </button>
                  <span style={{ fontSize: '0.85rem', color: '#6B7280' }}>
                    Combine all {subfolderFiles.length} pages into one view
                  </span>
                </div>
              )}

              <div style={styles.fileGrid}>
                {subfolderFiles.map(file => {
                  const isExtractPage = currentFolder === 'Extracts' && file.name.match(/^\d+\./);
                  const pageNumber = isExtractPage ? file.name.split('.')[0] : null;

                  return (
                    <div
                      key={file.id}
                      style={styles.fileCard}
                      onClick={() => handleFilePreview(file)}
                    >
                      <div style={styles.fileIcon}>
                        {isExtractPage ? (
                          <span style={{ fontSize: '16px', fontWeight: 'bold' }}>
                            {pageNumber}
                          </span>
                        ) : (
                          <FileIcon />
                        )}
                      </div>
                      <div style={styles.fileInfo}>
                        <h4 style={styles.fileName}>
                          {isExtractPage ? `Page ${pageNumber}` : file.name}
                        </h4>
                        <p style={styles.fileDetails}>
                          {file.folder}
                        </p>
                        <p style={styles.fileDate}>{formatDate(file.uploadDate)}</p>
                        <p style={styles.fileDescription}>{file.aiDescription}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : selectedFolder !== 'all' && filteredFiles.length > 0 ? (
            <div style={styles.searchResults}>
              <h3>{FOLDER_CONFIG[selectedFolder]?.name || selectedFolder} ({filteredFiles.length})</h3>
              <p style={{ marginBottom: '1rem', color: '#6B7280' }}>
                Files in {selectedFolder} folder
              </p>
              <div style={styles.fileGrid}>
                {filteredFiles.map(file => (
                  <div
                    key={file.id}
                    style={styles.fileCard}
                    onClick={() => handleFilePreview(file)}
                  >
                    <div style={styles.fileIcon}>
                      <FileIcon />
                    </div>
                    <div style={styles.fileInfo}>
                      <h4 style={styles.fileName}>{file.name}</h4>
                      <p style={styles.fileDetails}>
                        {file.folder}
                      </p>
                      <p style={styles.fileDate}>{formatDate(file.uploadDate)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : searchTerm && filteredFiles.length > 0 ? (
            <div style={styles.searchResults}>
              <h3>Found {filteredFiles.length} results for "{searchTerm}"</h3>
              <div style={styles.fileGrid}>
                {filteredFiles.map(file => (
                  <div
                    key={file.id}
                    style={styles.fileCard}
                    onClick={() => handleFilePreview(file)}
                  >
                    <div style={styles.fileIcon}>
                      <FileIcon />
                    </div>
                    <div style={styles.fileInfo}>
                      <h4 style={styles.fileName}>{file.name}</h4>
                      <p style={styles.fileDetails}>
                        {file.folder}
                      </p>
                      <p style={styles.fileDate}>{formatDate(file.uploadDate)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={styles.dropZoneArea}>
              <h3>Drop files here or click to browse</h3>
              <p>AI will automatically sort files into the right folders</p>
              <div style={styles.supportedTypes}>
                <p>Supported: Images, PDFs, Audio, Video, Code, Documents</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {}
      {showPdfPopup && pendingPdfFile && (
        <div style={pdfPopupStyles.overlay}>
          <div style={pdfPopupStyles.popup}>
            <div style={pdfPopupStyles.header}>
              <h3 style={pdfPopupStyles.title}>PDF Upload Options</h3>
              <button
                onClick={() => {
                  setShowPdfPopup(false);
                  setPendingPdfFile(null);
                }}
                style={pdfPopupStyles.closeButton}
              >
                ✕
              </button>
            </div>

            <div style={pdfPopupStyles.fileInfo}>
              <strong>File:</strong> {pendingPdfFile.name}
            </div>

            <div style={pdfPopupStyles.options}>
              {}
              <div style={pdfPopupStyles.option}>
                <h4 style={pdfPopupStyles.optionTitle}>Just Import</h4>
                <p style={pdfPopupStyles.optionDescription}>Upload PDF to the PDFs folder without processing</p>
                <ul style={pdfPopupStyles.featureList}>
                  <li>Fast upload</li>
                  <li>No additional processing time</li>
                  <li>Original PDF preserved</li>
                </ul>
                <button
                  onClick={() => handlePdfUploadChoice('import')}
                  disabled={pdfPopupLoading}
                  style={{
                    ...pdfPopupStyles.actionButton,
                    opacity: pdfPopupLoading ? 0.6 : 1,
                    cursor: pdfPopupLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {pdfPopupLoading ? 'Processing...' : 'Just Import'}
                </button>
              </div>

              {}
              <div style={pdfPopupStyles.option}>
                <h4 style={pdfPopupStyles.optionTitle}>Import + OCR</h4>
                <p style={pdfPopupStyles.optionDescription}>Upload PDF and extract text content using AI</p>
                <ul style={pdfPopupStyles.featureList}>
                  <li>Text extraction with AI</li>
                  <li>Searchable content</li>
                  <li>~40 seconds per page</li>
                  <li>Results saved to Extracts folder</li>
                </ul>

                <div style={pdfPopupStyles.pageRange}>
                  <label style={pdfPopupStyles.label}>Page Range:</label>
                  <div style={pdfPopupStyles.pageInputs}>
                    <div style={pdfPopupStyles.inputGroup}>
                      <label style={pdfPopupStyles.smallLabel}>Start</label>
                      <input
                        type="number"
                        value={startPage}
                        onChange={(e) => {
                          const newStart = Math.max(1, Math.min(pdfPageCount, parseInt(e.target.value) || 1));
                          setStartPage(newStart);
                          if (newStart > endPage) setEndPage(newStart);
                        }}
                        min="1"
                        max={pdfPageCount}
                        style={pdfPopupStyles.pageInput}
                      />
                    </div>
                    <div style={pdfPopupStyles.inputGroup}>
                      <label style={pdfPopupStyles.smallLabel}>End</label>
                      <input
                        type="number"
                        value={endPage}
                        onChange={(e) => setEndPage(Math.max(startPage, Math.min(pdfPageCount, parseInt(e.target.value) || startPage)))}
                        min={startPage}
                        max={pdfPageCount}
                        style={pdfPopupStyles.pageInput}
                      />
                    </div>
                  </div>
                  <p style={pdfPopupStyles.pageInfo}>
                    {endPage - startPage + 1} of {pdfPageCount} pages • Est. {Math.ceil((endPage - startPage + 1) * 40 / 60)} min
                  </p>
                </div>

                <div style={pdfPopupStyles.modelSelect}>
                  <label style={pdfPopupStyles.label}>AI Model:</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    style={pdfPopupStyles.select}
                  >
                    {models.map(model => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={() => handlePdfUploadChoice('ocr')}
                  disabled={pdfPopupLoading}
                  style={{
                    ...pdfPopupStyles.actionButton,
                    opacity: pdfPopupLoading ? 0.6 : 1,
                    cursor: pdfPopupLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {pdfPopupLoading ? 'Starting OCR...' : 'Import + OCR'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {}
      {showOcrProgressPopup && (
        <div style={ocrProgressStyles.overlay}>
          <div style={ocrProgressStyles.popup}>
            <div style={ocrProgressStyles.header}>
              <h3 style={ocrProgressStyles.title}>Processing OCR</h3>
              <button
                onClick={() => setShowOcrProgressPopup(false)}
                style={ocrProgressStyles.closeButton}
              >
                ✕
              </button>
            </div>

            <div style={ocrProgressStyles.fileInfo}>
              <p><strong>File:</strong> {ocrProgress.fileName}</p>
              <p><strong>Model:</strong> {selectedModel}</p>
              <p><strong>Progress:</strong> {ocrProgress.currentPage} / {ocrProgress.totalPages} pages</p>
            </div>

            <div style={ocrProgressStyles.progressSection}>
              <div style={ocrProgressStyles.progressBar}>
                <div
                  style={{
                    ...ocrProgressStyles.progressFill,
                    width: `${(ocrProgress.currentPage / ocrProgress.totalPages) * 100}%`
                  }}
                />
              </div>
              <p style={ocrProgressStyles.progressText}>
                {(() => {
                  console.log('📊 Progress state:', {
                    currentPage: ocrProgress.currentPage,
                    totalPages: ocrProgress.totalPages,
                    isCompleted: ocrProgress.isCompleted,
                    completedPages: ocrProgress.completedPages,
                    errorCount: ocrProgress.errorCount
                  });
                  
                  if (ocrProgress.currentPage === 0) return 'Starting...';
                  if (ocrProgress.isCompleted) return (
              <span style={{ display: 'flex', alignItems: 'center' }}>
                <FaCheck style={{ color: '#10B981', marginRight: '6px' }} />
                Completed!
              </span>
            );
                  if (ocrProgress.currentPage < ocrProgress.totalPages) return `Processing page ${ocrProgress.currentPage}...`;
                  return 'Finalizing results...';
                })()}
              </p>
            </div>

            <div style={ocrProgressStyles.timeInfo}>
              <p>{ocrProgress.isCompleted ? 'Processing complete' : `Estimated time remaining: ${formatTimeRemaining(ocrProgress.estimatedTimeRemaining)}`}</p>
              <p>Started: {ocrProgress.startTime?.toLocaleTimeString()}</p>
            </div>

            <div style={ocrProgressStyles.note}>
              <p><em>💡 You can close this window - processing will continue in the background</em></p>
            </div>

            <div style={ocrProgressStyles.buttons}>
              <button
                onClick={() => {
                  setShowOcrProgressPopup(false);
                  setShowAllPagesModal(true);
                }}
                style={{
                  ...ocrProgressStyles.backgroundButton,
                  backgroundColor: '#28a745',
                  borderColor: '#28a745',
                  marginRight: '10px'
                }}
              >
                View All Pages ({Object.keys(ocrProgress.allPagesResults).length} pages)
              </button>
              {ocrProgress.errorCount > 0 && (
                <button
                  onClick={() => {
                    setShowOcrProgressPopup(false);
                    setShowFailedPagesModal(true);
                  }}
                  style={{
                    ...ocrProgressStyles.backgroundButton,
                    backgroundColor: '#dc3545',
                    borderColor: '#dc3545'
                  }}
                >
                  View Failed Pages ({ocrProgress.errorCount})
                </button>
              )}
            </div>

          </div>
        </div>
      )}

      {}
      {showAllPagesModal && (
        <div style={allPagesModalStyles.overlay}>
          <div style={allPagesModalStyles.modal}>
            <div style={allPagesModalStyles.header}>
              <h3 style={allPagesModalStyles.title}>
            <FaFileAlt style={{ marginRight: '8px', color: '#3B82F6' }} />
            Complete OCR Results
          </h3>
              <button
                onClick={() => setShowAllPagesModal(false)}
                style={allPagesModalStyles.closeButton}
              >
                ✕
              </button>
            </div>

            <div style={allPagesModalStyles.content}>
              {Object.keys(ocrProgress.allPagesResults).length > 0 ? (
                <>
                  <div style={allPagesModalStyles.summary}>
                    <strong>{ocrProgress.fileName}</strong> - {ocrProgress.completedPages} successful, {ocrProgress.errorCount} failed
                  </div>
                  
                  <div style={allPagesModalStyles.pagesList}>
                    {Object.entries(ocrProgress.allPagesResults)
                      .sort(([a], [b]) => parseInt(a) - parseInt(b))
                      .map(([pageNum, result]) => (
                      <div key={pageNum} style={allPagesModalStyles.pageItem}>
                        <div style={allPagesModalStyles.pageInfo}>
                          <div style={allPagesModalStyles.pageHeader}>
                            <strong>Page {pageNum}</strong>
                            <span style={{
                              ...allPagesModalStyles.statusBadge,
                              backgroundColor: result.status === 'success' ? '#d4edda' : '#f8d7da',
                              color: result.status === 'success' ? '#155724' : '#721c24'
                            }}>
                              {result.status === 'success' ? (
                        <span style={{ display: 'flex', alignItems: 'center' }}>
                          <FaCheck style={{ marginRight: '4px', color: '#10B981' }} />
                          Success
                        </span>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center' }}>
                          <FaTimes style={{ marginRight: '4px', color: '#DC2626' }} />
                          Failed
                        </span>
                      )}
                            </span>
                          </div>
                          
                          <div style={allPagesModalStyles.pageDetails}>
                            <div><strong>Model:</strong> {result.modelUsed || 'Unknown'}</div>
                            {result.processingTime && (
                              <div><strong>Time:</strong> {(result.processingTime / 1000).toFixed(1)}s</div>
                            )}
                            {result.textLength && (
                              <div><strong>Text Length:</strong> {result.textLength} characters</div>
                            )}
                            {result.timestamp && (
                              <div><strong>Processed:</strong> {new Date(result.timestamp).toLocaleString()}</div>
                            )}
                          </div>

                          {}
                          <div style={allPagesModalStyles.pageActions}>
                            <button
                              onClick={() => {
                                if (result.driveId) {
                                  window.open(`https://drive.google.com/file/d/${result.driveId}/view`, '_blank');
                                } else {
                                  alert('Preview not available - file ID not found');
                                }
                              }}
                              style={allPagesModalStyles.actionButton}
                              title="Preview OCR Result"
                            >
                              <FaEye style={{ marginRight: '6px' }} />
              Preview
                            </button>
                            <button
                              onClick={() => handleRetryClick(parseInt(pageNum))}
                              disabled={retryingPages.has(parseInt(pageNum))}
                              style={{
                                ...allPagesModalStyles.actionButton,
                                backgroundColor: result.status === 'success' ? '#e3f2fd' : '#fff3e0',
                                borderColor: result.status === 'success' ? '#1976d2' : '#f57c00',
                                opacity: retryingPages.has(parseInt(pageNum)) ? 0.6 : 1,
                                cursor: retryingPages.has(parseInt(pageNum)) ? 'not-allowed' : 'pointer'
                              }}
                              title="Re-run OCR for this page"
                            >
                              {retryingPages.has(parseInt(pageNum)) ? (
                  <>
                    <FaSync style={{ marginRight: '6px', animation: 'spin 1s linear infinite' }} />
                    Processing...
                  </>
                ) : (
                  <>
                    <FaRedo style={{ marginRight: '6px' }} />
                    Re-run
                  </>
                )}
                            </button>
                          </div>

                          {result.status === 'error' && result.error && (
                            <div style={allPagesModalStyles.errorDetails}>
                              <strong>Error:</strong> {result.error}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={allPagesModalStyles.noResults}>
                  No OCR results available
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {}
      {showFailedPagesModal && (
        <div style={allPagesModalStyles.overlay}>
          <div style={allPagesModalStyles.modal}>
            <div style={allPagesModalStyles.header}>
              <h3 style={allPagesModalStyles.title}>
            <FaTimes style={{ marginRight: '8px', color: '#DC2626' }} />
            Failed Pages
          </h3>
              <button
                onClick={() => setShowFailedPagesModal(false)}
                style={allPagesModalStyles.closeButton}
              >
                ✕
              </button>
            </div>

            <div style={allPagesModalStyles.content}>
              {Object.keys(ocrProgress.failedPages).length > 0 ? (
                <div style={allPagesModalStyles.pagesList}>
                  {Object.entries(ocrProgress.failedPages)
                    .sort(([a], [b]) => parseInt(a) - parseInt(b))
                    .map(([pageNum, failure]) => (
                    <div key={pageNum} style={allPagesModalStyles.pageItem}>
                      <div style={allPagesModalStyles.pageInfo}>
                        <div style={allPagesModalStyles.pageHeader}>
                          <strong>Page {pageNum}</strong>
                          <span style={{
                            ...allPagesModalStyles.statusBadge,
                            backgroundColor: '#f8d7da',
                            color: '#721c24'
                          }}>
                            <FaTimes style={{ marginRight: '4px', color: '#DC2626' }} />
                Failed
                          </span>
                        </div>
                        
                        <div style={allPagesModalStyles.errorDetails}>
                          <strong>Error:</strong> {failure.error}
                        </div>
                        
                        <div style={allPagesModalStyles.pageDetails}>
                          <div><strong>Failed at:</strong> {failure.timestamp.toLocaleString()}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={allPagesModalStyles.noResults}>
                  No failed pages
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {}
      {showModelSelectionModal && (
        <div style={modelSelectionModalStyles.overlay}>
          <div style={modelSelectionModalStyles.modal}>
            <div style={modelSelectionModalStyles.header}>
              <h3 style={modelSelectionModalStyles.title}>
                <FaRedo style={{ marginRight: '8px', color: '#3B82F6' }} />
                Select OCR Model
              </h3>
              <button
                onClick={() => {
                  setShowModelSelectionModal(false);
                  setPendingRetryPage(null);
                }}
                style={modelSelectionModalStyles.closeButton}
              >
                ✕
              </button>
            </div>

            <div style={modelSelectionModalStyles.content}>
              <p style={modelSelectionModalStyles.description}>
                Choose which AI model to use for re-processing page {pendingRetryPage}:
              </p>
              
              <div style={modelSelectionModalStyles.options}>
                {models.map((model, index) => (
                  <button
                    key={model.value}
                    onClick={() => handleModelSelection(model.value)}
                    style={modelSelectionModalStyles.modelButton}
                  >
                    <div style={modelSelectionModalStyles.modelInfo}>
                      <strong>
                        {index === 0 ? (
                          <FaBolt style={{ marginRight: '6px', color: '#F59E0B' }} />
                        ) : (
                          <FaBullseye style={{ marginRight: '6px', color: '#DC2626' }} />
                        )}
                        {model.label}
                      </strong>
                      <div style={modelSelectionModalStyles.modelDescription}>{model.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {}
      {showPreviewModal && selectedFile && (
        <div style={previewStyles.overlay}>
          <div style={previewStyles.popup}>
            <h3 style={previewStyles.title}>File Preview</h3>

            <div style={previewStyles.fileInfo}>
              <p><strong>File:</strong> {selectedFile.name}</p>
              <p><strong>Type:</strong> {selectedFile.type}</p>
            </div>

            <div style={previewStyles.content}>
              {loadingPreview ? (
                <div style={previewStyles.loading}>
                  <div style={previewStyles.spinner}></div>
                  <p>Loading preview...</p>
                </div>
              ) : (
                <>
                  {previewError ? (
                    <div style={previewStyles.error}>
                      <p>{previewError}</p>
                    </div>
                  ) : (
                    <>
                      {selectedFile.type.startsWith('image/') ? (
                        <div style={previewStyles.imageContainer}>
                          <Image src={fileContent} alt={selectedFile.name} width={800} height={600} style={previewStyles.image} />
                        </div>
                      ) : selectedFile.type === 'application/pdf' ? (
                        <div style={previewStyles.pdfContainer}>
                          <iframe src={fileContent} title={selectedFile.name} style={previewStyles.pdfFrame}></iframe>
                        </div>
                      ) : (
                        <div style={previewStyles.textContainer}>
                          <pre style={previewStyles.text}>{fileContent}</pre>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>

            <div style={previewStyles.buttons}>
              {}
              {selectedFile.type === 'application/pdf' && (
                <button
                  onClick={() => handlePdfReOcr(selectedFile)}
                  style={{
                    ...previewStyles.reOcrButton,
                    marginRight: '10px'
                  }}
                >
                  <FaSearchPlus style={{ marginRight: '6px' }} />
                  Re-OCR
                </button>
              )}
              <button
                onClick={closePreviewModal}
                style={previewStyles.closeButton}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {}
      {showOcrOptionsModal && selectedFile && (
        <div style={ocrOptionsStyles.overlay}>
          <div style={ocrOptionsStyles.popup}>
            <h3 style={ocrOptionsStyles.title}>
              <FaSearchPlus style={{ marginRight: '8px', color: '#0C1C78' }} />
              Re-OCR Options
            </h3>

            <div style={ocrOptionsStyles.fileInfo}>
              <p><strong>File:</strong> {selectedFile.name}</p>
              <p><strong>Size:</strong> {(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
            </div>

            <div style={ocrOptionsStyles.options}>
              <div style={ocrOptionsStyles.pageRange}>
                <h4 style={ocrOptionsStyles.sectionTitle}>Page Range:</h4>
                <p style={ocrOptionsStyles.description}>
                  Specify which pages to re-process. For entire document, use pages 1-999.
                </p>
                <div style={ocrOptionsStyles.pageInputs}>
                  <div style={ocrOptionsStyles.inputGroup}>
                    <label style={ocrOptionsStyles.label}>Start Page:</label>
                    <input
                      type="number"
                      min="1"
                      value={ocrStartPage}
                      onChange={(e) => setOcrStartPage(parseInt(e.target.value) || 1)}
                      style={ocrOptionsStyles.input}
                    />
                  </div>
                  <div style={ocrOptionsStyles.inputGroup}>
                    <label style={ocrOptionsStyles.label}>End Page:</label>
                    <input
                      type="number"
                      min="1"
                      value={ocrEndPage}
                      onChange={(e) => setOcrEndPage(parseInt(e.target.value) || 1)}
                      style={ocrOptionsStyles.input}
                    />
                  </div>
                </div>
                <p style={ocrOptionsStyles.estimate}>
                  Estimated time: {Math.max(1, Math.ceil((ocrEndPage - ocrStartPage + 1) * 0.5))} minutes
                </p>
              </div>
            </div>

            <div style={ocrOptionsStyles.buttons}>
              <button
                onClick={() => setShowOcrOptionsModal(false)}
                style={ocrOptionsStyles.cancelButton}
                disabled={ocrOptionsLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleOcrOptionsConfirm}
                style={ocrOptionsStyles.confirmButton}
                disabled={ocrOptionsLoading}
              >
                {ocrOptionsLoading ? 'Processing...' : 'Start Re-OCR'}
              </button>
            </div>
          </div>
        </div>
      )}

      {}
      <DuplicateFileModal
        conflicts={pendingConflicts}
        isOpen={duplicateModalOpen}
        onResolve={handleConflictResolution}
        onCancel={handleUploadCancel}
      />
    </div>
  );
}

const pdfPopupStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
    backdropFilter: 'blur(8px)',
    padding: '20px',
    boxSizing: 'border-box' as const },
  popup: {
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    padding: '1.5rem',
    maxWidth: '900px',
    width: '90%',
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 25px 50px rgba(0, 0, 0, 0.3)',
    border: '1px solid #e5e7eb' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.25rem',
    paddingBottom: '1rem',
    borderBottom: '2px solid #F0F4FC' },
  title: {
    margin: 0,
    color: '#11074A',
    fontSize: '1.5rem',
    fontWeight: '700' },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    color: '#6b7280',
    cursor: 'pointer',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
    transition: 'all 0.2s ease' },
  fileInfo: {
    marginBottom: '1.25rem',
    padding: '0.75rem 1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '8px',
    fontSize: '0.9rem',
    color: '#11074A',
    borderLeft: '3px solid #11074A' },
  options: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1.25rem' },
  option: {
    padding: '1.25rem',
    border: '2px solid #e5e7eb',
    borderRadius: '12px',
    backgroundColor: '#FFFFFF',
    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)' },
  optionTitle: {
    margin: '0 0 0.5rem 0',
    color: '#11074A',
    fontSize: '1.1rem',
    fontWeight: '700' },
  optionDescription: {
    margin: '0 0 0.75rem 0',
    color: '#6b7280',
    fontSize: '0.85rem',
    lineHeight: '1.4' },
  featureList: {
    margin: '0 0 1rem 0',
    paddingLeft: '1.25rem',
    color: '#4a5568',
    fontSize: '0.85rem',
    lineHeight: '1.6' },
  actionButton: {
    width: '100%',
    padding: '0.75rem',
    border: 'none',
    borderRadius: '8px',
    backgroundColor: '#11074A',
    color: '#FFFFFF',
    cursor: 'pointer',
    fontSize: '0.95rem',
    fontWeight: '600',
    transition: 'all 0.2s ease',
    marginTop: '0.5rem' },
  pageRange: {
    marginBottom: '1rem',
    padding: '0.75rem',
    backgroundColor: '#F8F9FA',
    borderRadius: '8px',
    border: '1px solid #e5e7eb' },
  label: {
    display: 'block',
    marginBottom: '0.5rem',
    color: '#11074A',
    fontSize: '0.85rem',
    fontWeight: '600' },
  smallLabel: {
    display: 'block',
    marginBottom: '0.25rem',
    color: '#6b7280',
    fontSize: '0.75rem',
    fontWeight: '500' },
  pageInputs: {
    display: 'flex',
    gap: '0.75rem',
    marginBottom: '0.5rem' },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.25rem',
    flex: 1 },
  pageInput: {
    padding: '0.5rem',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    backgroundColor: '#FFFFFF',
    fontSize: '0.9rem',
    color: '#11074A',
    fontWeight: '600' },
  pageInfo: {
    margin: '0',
    fontSize: '0.75rem',
    color: '#6b7280',
    fontWeight: '500' },
  modelSelect: {
    marginBottom: '1rem' },
  select: {
    width: '100%',
    padding: '0.5rem',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    backgroundColor: '#FFFFFF',
    fontSize: '0.85rem',
    color: '#11074A',
    fontWeight: '600' } };

const ocrProgressStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(30, 28, 54, 0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100 },
  popup: {
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    padding: '2rem',
    maxWidth: '600px',
    width: '90%',
    maxHeight: '85vh',
    overflow: 'auto',
    boxShadow: '0 25px 50px rgba(30, 28, 54, 0.4)',
    border: '1px solid #F0F4FC' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem' },
  title: {
    margin: '0',
    color: '#1E1C36',
    fontSize: '1.6rem',
    fontWeight: '700' },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    color: '#6c757d',
    padding: '0.25rem' },
  fileInfo: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '8px',
    fontSize: '0.9rem',
    color: '#4E4B7A' },
  progressSection: {
    marginBottom: '1.5rem' },
  progressBar: {
    width: '100%',
    height: '12px',
    backgroundColor: '#F0F4FC',
    borderRadius: '6px',
    overflow: 'hidden',
    marginBottom: '0.5rem' },
  progressFill: {
    height: '100%',
    backgroundColor: '#0C1C78',
    borderRadius: '6px',
    transition: 'width 0.3s ease' },
  progressText: {
    margin: '0',
    textAlign: 'center',
    color: '#4E4B7A',
    fontWeight: '500' },
  timeInfo: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#FCFCFC',
    borderRadius: '8px',
    border: '1px solid #F0F4FC',
    fontSize: '0.9rem',
    color: '#4E4B7A' },
  note: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#FFF7ED',
    borderRadius: '8px',
    border: '1px solid #FED7AA',
    fontSize: '0.9rem',
    color: '#9A3412' },
  buttons: {
    display: 'flex',
    justifyContent: 'center' },
  backgroundButton: {
    padding: '0.75rem 2rem',
    border: '1px solid #0C1C78',
    borderRadius: '8px',
    backgroundColor: '#FFFFFF',
    color: '#0C1C78',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: '600',
    transition: 'all 0.2s ease' } };

const previewStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(30, 28, 54, 0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000 },
  popup: {
    backgroundColor: '#FFFFFF',
    borderRadius: '12px',
    padding: '2rem',
    maxWidth: '800px',
    width: '95%',
    maxHeight: '85vh',
    overflow: 'auto',
    boxShadow: '0 20px 40px rgba(30, 28, 54, 0.3)',
    border: '1px solid #F0F4FC' },
  title: {
    margin: '0 0 1.5rem 0',
    color: '#1E1C36',
    fontSize: '1.5rem',
    fontWeight: '700',
    textAlign: 'center' },
  fileInfo: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '8px',
    fontSize: '0.9rem',
    color: '#4E4B7A' },
  content: {
    marginBottom: '1.5rem' },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '300px',
    color: '#4E4B7A' },
  spinner: {
    width: '40px',
    height: '40px',
    border: '3px solid #F0F4FC',
    borderTop: '3px solid #0C1C78',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    marginBottom: '1rem' },
  error: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#FEE2E2',
    borderRadius: '8px',
    border: '1px solid #DC2626',
    color: '#DC2626' },
  imageContainer: {
    marginBottom: '1.5rem' },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    borderRadius: '8px' },
  pdfContainer: {
    marginBottom: '1.5rem' },
  pdfFrame: {
    width: '100%',
    height: '300px',
    border: 'none',
    borderRadius: '8px' },
  textContainer: {
    marginBottom: '1.5rem' },
  text: {
    whiteSpace: 'pre-wrap',
    fontFamily: 'Monaco, Consolas, "Lucida Console", monospace',
    fontSize: '0.9rem',
    lineHeight: '1.6',
    color: '#1E1C36',
    backgroundColor: '#F8F9FA',
    padding: '1.5rem',
    borderRadius: '8px',
    border: '1px solid #E9ECEF',
    maxHeight: '400px',
    overflow: 'auto' },
  buttons: {
    display: 'flex',
    justifyContent: 'center' },
  closeButton: {
    padding: '0.75rem 1.5rem',
    border: '1px solid #F0F4FC',
    borderRadius: '6px',
    backgroundColor: '#FFFFFF',
    color: '#4E4B7A',
    cursor: 'pointer',
    fontSize: '1rem',
    transition: 'all 0.2s ease' },
  reOcrButton: {
    padding: '0.75rem 1rem',
    border: '1px solid #0C1C78',
    borderRadius: '4px',
    backgroundColor: '#FFFFFF',
    color: '#0C1C78',
    cursor: 'pointer',
    fontSize: '0.9rem',
    transition: 'all 0.2s ease' } };

const ocrOptionsStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(30, 28, 54, 0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000 },
  popup: {
    backgroundColor: '#FFFFFF',
    borderRadius: '12px',
    padding: '2rem',
    maxWidth: '500px',
    width: '95%',
    maxHeight: '80vh',
    overflow: 'auto',
    boxShadow: '0 20px 40px rgba(30, 28, 54, 0.3)',
    border: '1px solid #F0F4FC' },
  title: {
    margin: '0 0 1.5rem 0',
    color: '#1E1C36',
    fontSize: '1.5rem',
    fontWeight: '700',
    textAlign: 'center' },
  fileInfo: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '8px',
    fontSize: '0.9rem',
    color: '#4E4B7A' },
  options: {
    marginBottom: '2rem' },
  pageRange: {
    marginBottom: '1rem' },
  sectionTitle: {
    margin: '0 0 0.75rem 0',
    color: '#1E1C36',
    fontSize: '1rem',
    fontWeight: '600' },
  description: {
    margin: '0 0 1rem 0',
    fontSize: '0.9rem',
    color: '#6C757D',
    lineHeight: '1.4' },
  pageInputs: {
    display: 'flex',
    gap: '1rem',
    marginBottom: '1rem' },
  inputGroup: {
    flex: 1 },
  label: {
    display: 'block',
    marginBottom: '0.5rem',
    fontSize: '0.9rem',
    fontWeight: '500',
    color: '#1E1C36' },
  input: {
    width: '100%',
    padding: '0.75rem',
    border: '1px solid #E9ECEF',
    borderRadius: '4px',
    fontSize: '0.9rem',
    color: '#1E1C36' },
  estimate: {
    fontSize: '0.8rem',
    color: '#6C757D',
    fontStyle: 'italic' },
  buttons: {
    display: 'flex',
    gap: '1rem',
    justifyContent: 'flex-end' },
  cancelButton: {
    padding: '0.75rem 1.5rem',
    border: '1px solid #E9ECEF',
    borderRadius: '4px',
    backgroundColor: '#FFFFFF',
    color: '#6C757D',
    cursor: 'pointer',
    fontSize: '0.9rem',
    transition: 'all 0.2s ease' },
  confirmButton: {
    padding: '0.75rem 1.5rem',
    border: '1px solid #0C1C78',
    borderRadius: '4px',
    backgroundColor: '#0C1C78',
    color: '#FFFFFF',
    cursor: 'pointer',
    fontSize: '0.9rem',
    transition: 'all 0.2s ease' } };

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#FCFCFC',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },

  title: {
    margin: '0 0 0.5rem 0',
    fontSize: '2rem',
    fontWeight: '700',
    color: '#1E1C36' },
  subtitle: {
    margin: '0',
    fontSize: '1rem',
    color: '#4E4B7A' },
  searchSection: {
    padding: '1.5rem 2rem',
    backgroundColor: '#FFFFFF',
    borderBottom: '1px solid #F0F4FC' },
  searchBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.75rem 1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '8px',
    border: '1px solid rgba(78, 75, 122, 0.3)' },
  searchInput: {
    flex: 1,
    border: 'none',
    backgroundColor: 'transparent',
    outline: 'none',
    fontSize: '1rem',
    color: '#1E1C36' },
  filterButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 1rem',
    backgroundColor: '#0C1C78',
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: '500' },
  filterPanel: {
    display: 'flex',
    gap: '1rem',
    marginTop: '1rem',
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '6px' },
  filterGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem' },
  mainContent: {
    display: 'flex',
    minHeight: 'calc(100vh - 200px)' },
  sidebar: {
    width: '300px',
    backgroundColor: '#FFFFFF',
    borderRight: '1px solid #F0F4FC',
    padding: '1.5rem' },
  uploadSection: {
    marginBottom: '2rem' },
  folderList: {
    marginBottom: '2rem' },
  sidebarTitle: {
    margin: '0 0 1rem 0',
    fontSize: '1.1rem',
    fontWeight: '600',
    color: '#1E1C36' },
  folderItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.75rem',
    borderRadius: '6px',
    cursor: 'pointer',
    color: '#4E4B7A',
    transition: 'all 0.2s ease',
    marginBottom: '0.25rem' },
  folderItemActive: {
    backgroundColor: '#F0F4FC',
    color: '#1E1C36',
    fontWeight: '500' },
  subfolderList: {
    marginLeft: '1.5rem',
    borderLeft: '2px solid #F0F4FC',
    paddingLeft: '0.75rem',
    marginTop: '0.25rem' },
  subfolderItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.75rem',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#6B7280',
    fontSize: '0.9rem',
    transition: 'all 0.2s ease',
    marginBottom: '0.125rem' },
  subfolderItemActive: {
    backgroundColor: '#E0F2FE',
    color: '#059669',
    fontWeight: '500' },
  fileDescription: {
    margin: '0.25rem 0 0 0',
    fontSize: '0.75rem',
    color: '#8B5CF6',
    fontStyle: 'italic' },
  stats: {
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '6px' },
  statsTitle: {
    margin: '0 0 0.75rem 0',
    fontSize: '1rem',
    fontWeight: '600',
    color: '#1E1C36' },
  content: {
    flex: 1,
    padding: '1.5rem' },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '300px',
    color: '#4E4B7A' },
  spinner: {
    width: '40px',
    height: '40px',
    border: '3px solid #F0F4FC',
    borderTop: '3px solid #0C1C78',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    marginBottom: '1rem' },
  searchResults: {
    marginBottom: '2rem' },
  fileGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '1rem',
    marginTop: '1rem' },
  fileCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '1rem',
    backgroundColor: '#FFFFFF',
    border: '1px solid #F0F4FC',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    boxShadow: '0 1px 3px rgba(30, 28, 54, 0.1)' },
  fileIcon: {
    width: '40px',
    height: '40px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F4FC',
    borderRadius: '6px',
    color: '#1E1C36' },
  fileInfo: {
    flex: 1 },
  fileName: {
    margin: '0 0 0.25rem 0',
    fontSize: '0.9rem',
    fontWeight: '500',
    color: '#1E1C36' },
  fileDetails: {
    margin: '0 0 0.25rem 0',
    fontSize: '0.8rem',
    color: '#4E4B7A' },
  fileDate: {
    margin: '0',
    fontSize: '0.75rem',
    color: '#6B7280' },
  dropZoneArea: {
    textAlign: 'center',
    padding: '3rem',
    border: '2px dashed #F0F4FC',
    borderRadius: '12px',
    color: '#4E4B7A' },
  supportedTypes: {
    marginTop: '1rem',
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '6px' },

  loadingContainer: {
    minHeight: '100vh',
    backgroundColor: '#FCFCFC',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  loadingContent: {
    textAlign: 'center',
    padding: '3rem',
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    boxShadow: '0 10px 25px rgba(30, 28, 54, 0.1)',
    border: '1px solid #F0F4FC',
    maxWidth: '500px',
    width: '90%' },
  loadingTitle: {
    margin: '1.5rem 0 0.5rem 0',
    fontSize: '1.5rem',
    fontWeight: '600',
    color: '#1E1C36' },
  loadingSubtitle: {
    margin: '0 0 2rem 0',
    fontSize: '1rem',
    color: '#4E4B7A' },
  progressSteps: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    textAlign: 'left' },
  progressStep: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.75rem 1rem',
    borderRadius: '8px',
    transition: 'all 0.3s ease' },
  progressStepActive: {
    backgroundColor: '#FFF7ED',
    color: '#9A3412',
    border: '1px solid #FED7AA' },
  progressStepComplete: {
    backgroundColor: '#F0FDF4',
    color: '#166534',
    border: '1px solid #BBF7D0' },
  progressStepPending: {
    backgroundColor: '#F8F9FA',
    color: '#6B7280',
    border: '1px solid #E5E7EB' },
  progressDot: {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.75rem',
    fontWeight: 'bold',
    backgroundColor: 'currentColor',
    color: 'white',
    flexShrink: 0 },
  heroSection: {
    position: 'relative',
    height: '360px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    overflow: 'hidden',
    marginBottom: '2rem' },
  heroContent: {
    position: 'relative',
    zIndex: 2,
    color: 'white',
    maxWidth: '800px',
    padding: '0 2rem' },
  heroTitle: {
    fontSize: '3rem',
    fontWeight: '700',
    margin: '0 0 1rem',
    textShadow: '0 2px 4px rgba(0, 0, 0, 0.3)' },
  heroSubtitle: {
    fontSize: '1.25rem',
    margin: '0 0 2rem',
    opacity: 0.9,
    textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)' },
  heroStats: {
    display: 'flex',
    justifyContent: 'center',
    gap: '3rem',
    marginTop: '2rem' },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '1rem',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: '12px',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    minWidth: '120px' },
  statNumber: {
    fontSize: '2rem',
    fontWeight: '700',
    color: 'white',
    marginBottom: '0.5rem' },
  statLabel: {
    fontSize: '0.9rem',
    color: 'rgba(255, 255, 255, 0.8)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px' } };

const SearchIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"></circle>
    <path d="m21 21-4.35-4.35"></path>
  </svg>
);

const FilterIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
  </svg>
);

const FolderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2l5 2h9a2 2 0 0 1 2 2z"></path>
  </svg>
);

const FileIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14,2 14,8 20,8"></polyline>
  </svg>
);

const allPagesModalStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(30, 28, 54, 0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100 },
  modal: {
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    padding: '0',
    maxWidth: '800px',
    width: '90%',
    maxHeight: '85vh',
    overflow: 'hidden',
    boxShadow: '0 25px 50px rgba(30, 28, 54, 0.4)',
    border: '1px solid #F0F4FC' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.5rem 2rem',
    borderBottom: '1px solid #F0F4FC',
    backgroundColor: '#FAFBFC' },
  title: {
    margin: 0,
    color: '#1E1C36',
    fontSize: '1.5rem',
    fontWeight: '700' },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    color: '#6c757d',
    padding: '0.25rem' },
  content: {
    padding: '2rem',
    maxHeight: '60vh',
    overflow: 'auto' },
  summary: {
    marginBottom: '1.5rem',
    padding: '1rem',
    backgroundColor: '#F0F4FC',
    borderRadius: '8px',
    fontSize: '1rem',
    color: '#1E1C36' },
  pagesList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem' },
  pageItem: {
    border: '1px solid #E9ECEF',
    borderRadius: '8px',
    padding: '1rem',
    backgroundColor: '#FAFBFC' },
  pageInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem' },
  pageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem' },
  statusBadge: {
    padding: '0.25rem 0.75rem',
    borderRadius: '4px',
    fontSize: '0.85rem',
    fontWeight: '600' },
  pageDetails: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '0.5rem',
    fontSize: '0.9rem',
    color: '#6C757D' },
  errorDetails: {
    marginTop: '0.5rem',
    padding: '0.75rem',
    backgroundColor: '#FEF2F2',
    border: '1px solid #FECACA',
    borderRadius: '6px',
    fontSize: '0.9rem',
    color: '#DC2626' },
  noResults: {
    textAlign: 'center',
    padding: '3rem',
    color: '#6C757D',
    fontSize: '1.1rem' },
  pageActions: {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '1rem',
    paddingTop: '0.75rem',
    borderTop: '1px solid #E9ECEF' },
  actionButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 1rem',
    border: '1px solid #28a745',
    borderRadius: '6px',
    backgroundColor: '#f8fff9',
    color: '#28a745',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: '500',
    transition: 'all 0.2s ease' } };

const modelSelectionModalStyles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(30, 28, 54, 0.9)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1200 },
  modal: {
    backgroundColor: '#FFFFFF',
    borderRadius: '16px',
    padding: '0',
    maxWidth: '500px',
    width: '90%',
    overflow: 'hidden',
    boxShadow: '0 25px 50px rgba(30, 28, 54, 0.4)',
    border: '1px solid #F0F4FC' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.5rem 2rem',
    borderBottom: '1px solid #F0F4FC',
    backgroundColor: '#FAFBFC' },
  title: {
    margin: 0,
    color: '#1E1C36',
    fontSize: '1.3rem',
    fontWeight: '700' },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    color: '#6c757d',
    padding: '0.25rem' },
  content: {
    padding: '2rem' },
  description: {
    margin: '0 0 1.5rem 0',
    color: '#4E4B7A',
    fontSize: '1rem',
    textAlign: 'center' },
  options: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem' },
  modelButton: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '1rem 1.5rem',
    border: '2px solid #E9ECEF',
    borderRadius: '12px',
    backgroundColor: '#FFFFFF',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    textAlign: 'left' },
  modelInfo: {
    flex: 1 },
  modelDescription: {
    marginTop: '0.5rem',
    fontSize: '0.9rem',
    color: '#6C757D' } };

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20,6 9,17 4,12"></polyline>
  </svg>
);

const LoadingIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"></circle>
    <path d="M12 2a10 10 0 0 1 10 10"></path>
  </svg>
);

const RefreshIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
  </svg>
);
