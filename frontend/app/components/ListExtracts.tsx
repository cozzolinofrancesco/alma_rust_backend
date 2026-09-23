"use client";
import { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom";
import { FaChevronDown, FaChevronUp, FaDatabase, FaExclamationTriangle, FaEye, FaPlus, FaSpinner, FaSyncAlt } from "react-icons/fa";
import Popup from "../components/Popup";
import styles from "../styles/ListExtracts.module.css";
import "../styles/extractsList.css";
import { useCollectionContext } from "./CollectionContext";
import CollectionPopup from "./CollectionPopup";
import CollectionManager from "./Collections";
import HowlChat from "./HowlChat";
import { useMasterContext } from "./MasterExtractContext";
import ProjectFilePicker, { SelectedFile } from "./ProjectFilePicker";
import { useProjectState } from "./ProjectStateContext";
import ScientificPaperSearch, { SelectedPaper } from "./ScientificPaperSearch";
import { useSharedSession } from "./SharedSessionProvider";

interface Folder {
  id: string;
  name: string;
}

interface FileItem {
  id: string;
  name: string;
  mimeType: string;
}

export interface SelectedRag {
  id: string;
  filename: string;
  theme: string;
  description: string;
  createdAt: string;
}

interface ListExtractsProps {
  onContextUpdate: (context: string) => void;
  onAgentFilesUpdate?: (files: SelectedFile[]) => void;
  onAgentPapersUpdate?: (papers: SelectedPaper[]) => void;
  onAgentRagUpdate?: (ragItems: SelectedRag[]) => void;
  hiddenTabs?: Array<'collections' | 'files' | 'rag' | 'papers'>;
}

interface Extract {
  fileId: string;
  fileName: string;
  pageNumber: string;
  content: string;
  PDFName: string;
  collection?: number;
}

export type UniquePageId = `${string}-${string}`;

function dedupFiles(files: FileItem[]): FileItem[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.name.split(".")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface CorpusItem {
  id: string;
  displayName: string;
  corpusId: string;
  source: {
    folderName: string;
    ownerEmail?: string;
  };
  files: Array<{
    name: string;
    status: string;
  }>;
  createdAt: string;
}

interface DriveFolder {
  id: string;
  name: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

interface RAGKnowledgeSectionProps {
  onRagSelected: (ragItems: SelectedRag[]) => void;
}

const RAGKnowledgeSection: React.FC<RAGKnowledgeSectionProps> = ({ onRagSelected }) => {
  const [corpora, setCorpora] = useState<CorpusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCorpora, setSelectedCorpora] = useState<Set<string>>(new Set());
  
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DriveFolder[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<DriveFolder | null>(null);
  const [folderFiles, setFolderFiles] = useState<DriveFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [corpusName, setCorpusName] = useState('');
  const [creating, setCreating] = useState(false);
  
  const [editingCorpusId, setEditingCorpusId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    fetchCorpora();
  }, []);

  const fetchCorpora = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/rag/corpora');

      if (!response.ok) {
        throw new Error('Failed to fetch corpora');
      }

      const data = await response.json();
      setCorpora(data.corpora || []);
      console.log(`[RAG] Loaded ${data.corpora?.length || 0} corpora`);

    } catch (err) {
      console.error('[RAG] Error fetching corpora:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const searchDriveFolders = async () => {
    if (!searchQuery.trim()) return;
    
    setSearching(true);
    try {
      const response = await fetch(`/api/rag/drive/search?q=${encodeURIComponent(searchQuery)}`);
      if (response.ok) {
        const data = await response.json();
        setSearchResults(data.folders || []);
      }
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setSearching(false);
    }
  };

  const loadFolderFiles = async (folder: DriveFolder) => {
    setSelectedFolder(folder);
    setFolderFiles([]);
    setSelectedFileIds(new Set());
    setLoadingFiles(true);
    
    try {
      const response = await fetch(`/api/rag/drive/folder/${folder.id}`);
      if (response.ok) {
        const data = await response.json();
        setFolderFiles(data.files || []);
      }
    } catch (error) {
      console.error('Failed to load folder:', error);
    } finally {
      setLoadingFiles(false);
    }
  };

  const toggleFile = (fileId: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  const createCorpus = async () => {
    if (!corpusName.trim() || selectedFileIds.size === 0 || !selectedFolder) {
      alert('Please provide a corpus name and select at least one file');
      return;
    }

    setCreating(true);
    try {
      const selectedFiles = folderFiles.filter((f) => selectedFileIds.has(f.id));
      
      const response = await fetch('/api/rag/corpora', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: corpusName,
          folderId: selectedFolder.id,
          selectedFileIds: Array.from(selectedFileIds),
          files: selectedFiles,
        }),
      });

      if (response.ok) {
        alert('Corpus created successfully!');
        setCorpusName('');
        setSelectedFileIds(new Set());
        setShowCreateForm(false);
        setSelectedFolder(null);
        setSearchResults([]);
        fetchCorpora();
      } else {
        const error = await response.json();
        alert(`Failed to create corpus: ${error.error}`);
      }
    } catch (error) {
      console.error('Create corpus error:', error);
      alert('Failed to create corpus');
    } finally {
      setCreating(false);
    }
  };

  const deleteCorpus = async (corpusId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this corpus? This cannot be undone.')) {
      return;
    }

    setDeleting(corpusId);
    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setCorpora((prev) => prev.filter((c) => c.id !== corpusId));
        setSelectedCorpora((prev) => {
          const newSet = new Set(prev);
          newSet.delete(corpusId);
          return newSet;
        });
      } else {
        alert('Failed to delete corpus');
      }
    } catch (error) {
      console.error('Error deleting corpus:', error);
      alert('Error deleting corpus');
    } finally {
      setDeleting(null);
    }
  };

  const startEditing = (corpus: CorpusItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingCorpusId(corpus.id);
    setEditingName(corpus.displayName);
  };

  const cancelEditing = () => {
    setEditingCorpusId(null);
    setEditingName('');
  };

  const saveRename = async (corpusId: string) => {
    if (!editingName.trim()) {
      alert('Name cannot be empty');
      return;
    }

    try {
      const res = await fetch(`/api/rag/corpora/${corpusId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: editingName }),
      });

      if (res.ok) {
        setCorpora((prev) =>
          prev.map((c) =>
            c.id === corpusId ? { ...c, displayName: editingName } : c
          )
        );
        setEditingCorpusId(null);
        setEditingName('');
      } else {
        alert('Failed to rename corpus');
      }
    } catch (error) {
      console.error('Error renaming corpus:', error);
      alert('Error renaming corpus');
    }
  };

  const handleSelectCorpus = (corpus: CorpusItem) => {
    setSelectedCorpora(prev => {
      const newSet = new Set(prev);
      if (newSet.has(corpus.id)) {
        newSet.delete(corpus.id);
      } else {
        newSet.add(corpus.id);
      }
      return newSet;
    });
  };

  useEffect(() => {
    const selectedRagItems: SelectedRag[] = corpora
      .filter(c => selectedCorpora.has(c.id))
      .map(c => ({
        id: c.id,
        filename: c.displayName,
        theme: 'Corpus',
        description: `${c.files.length} files from ${c.source.folderName}`,
        createdAt: c.createdAt
      }));

    onRagSelected(selectedRagItems);
  }, [selectedCorpora, corpora, onRagSelected]);

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '20px',
        color: '#666'
      }}>
        <FaSpinner className="fa-spin" style={{ fontSize: '20px', marginBottom: '8px' }} />
        <div style={{ fontSize: '14px' }}>Loading RAG corpora...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '20px',
        color: '#dc3545'
      }}>
        <FaExclamationTriangle style={{ fontSize: '20px', marginBottom: '8px' }} />
        <div style={{ marginBottom: '8px', fontWeight: '500' }}>Failed to load corpora</div>
        <div style={{ fontSize: '12px', textAlign: 'center', marginBottom: '12px' }}>
          {error}
        </div>
        <button
          onClick={fetchCorpora}
          style={{
            padding: '6px 12px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px'
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {}
      {!showCreateForm && (
        <button
          onClick={() => setShowCreateForm(true)}
          style={{
            width: '100%',
            padding: '10px',
            marginBottom: '12px',
            backgroundColor: '#11074A',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px'
          }}
        >
          <FaPlus /> Add Knowledge from Drive
        </button>
      )}

      {}
      {showCreateForm && (
        <div style={{
          border: '2px solid #11074A',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '12px',
          backgroundColor: '#f8f9fa'
        }}>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '10px', color: '#11074A' }}>
            Create New Knowledge Source
          </div>

          {}
          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', color: '#666', marginBottom: '4px', display: 'block' }}>
              Search Drive folder (name or paste ID):
            </label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && searchDriveFolders()}
                placeholder="Folder name or Drive ID..."
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  border: '1px solid #ddd',
                  borderRadius: '4px',
                  fontSize: '12px'
                }}
              />
              <button
                onClick={searchDriveFolders}
                disabled={searching}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#11074A',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                {searching ? <FaSpinner className="fa-spin" /> : 'Search'}
              </button>
            </div>
          </div>

          {}
          {searchResults.length > 0 && !selectedFolder && (
            <div style={{ marginBottom: '10px', maxHeight: '120px', overflowY: 'auto' }}>
              {searchResults.map((folder) => (
                <button
                  key={folder.id}
                  onClick={() => loadFolderFiles(folder)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    marginBottom: '4px',
                    backgroundColor: '#fff',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '12px'
                  }}
                >
                  📁 {folder.name}
                </button>
              ))}
            </div>
          )}

          {}
          {selectedFolder && (
            <>
              <div style={{ fontSize: '12px', color: '#666', marginBottom: '6px' }}>
                Selected folder: <strong>{selectedFolder.name}</strong>
              </div>

              {loadingFiles ? (
                <div style={{ textAlign: 'center', padding: '10px' }}>
                  <FaSpinner className="fa-spin" />
                </div>
              ) : (
                <div style={{ maxHeight: '150px', overflowY: 'auto', marginBottom: '10px' }}>
                  {folderFiles.map((file) => (
                    <label
                      key={file.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                      gap: '8px',
                      padding: '6px',
                      backgroundColor: selectedFileIds.has(file.id) ? '#f3f4f6' : '#fff',
                      border: '1px solid #ddd',
                        borderRadius: '4px',
                        marginBottom: '4px',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedFileIds.has(file.id)}
                        onChange={() => toggleFile(file.id)}
                      />
                      <span>{file.name}</span>
                      {file.size && (
                        <span style={{ marginLeft: 'auto', color: '#666', fontSize: '11px' }}>
                          {(file.size / 1024 / 1024).toFixed(1)} MB
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {}
              {selectedFileIds.size > 0 && (
                <>
                  <input
                    type="text"
                    value={corpusName}
                    onChange={(e) => setCorpusName(e.target.value)}
                    placeholder="Give this knowledge a name..."
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      border: '1px solid #ddd',
                      borderRadius: '4px',
                      fontSize: '12px',
                      marginBottom: '8px'
                    }}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={createCorpus}
                      disabled={creating}
                      style={{
                        flex: 1,
                        padding: '8px',
                        backgroundColor: '#11074A',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: '500'
                      }}
                    >
                      {creating ? <><FaSpinner className="fa-spin" /> Creating...</> : `Create (${selectedFileIds.size} files)`}
                    </button>
                    <button
                      onClick={() => {
                        setShowCreateForm(false);
                        setSelectedFolder(null);
                        setSearchResults([]);
                        setSelectedFileIds(new Set());
                      }}
                      style={{
                        padding: '8px 12px',
                        backgroundColor: '#6c757d',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {}
      {corpora.length === 0 && !showCreateForm ? (
        <div style={{
          textAlign: 'center',
          padding: '20px',
          color: '#666'
        }}>
          <FaDatabase style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.3 }} />
          <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '6px' }}>
            No Knowledge Sources Found
          </div>
          <div style={{ fontSize: '12px', lineHeight: '1.4' }}>
            Click "Add Knowledge from Drive" to import large documents (5000+ pages).
          </div>
        </div>
      ) : (
        <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
          {corpora.map((corpus) => {
            const isSelected = selectedCorpora.has(corpus.id);
            const isEditing = editingCorpusId === corpus.id;

            return (
              <div
                key={corpus.id}
                style={{
                  border: '1px solid #ddd',
                  borderRadius: '6px',
                  marginBottom: '8px',
                  padding: '10px',
                  backgroundColor: isSelected ? '#f3f4f6' : '#ffffff',
                  borderColor: isSelected ? '#11074A' : '#ddd',
                  cursor: isEditing ? 'default' : 'pointer',
                  fontSize: '13px'
                }}
                onClick={() => !isEditing && handleSelectCorpus(corpus)}
              >
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: '6px'
                }}>
                  <div style={{
                    fontWeight: '600',
                    color: '#333',
                    flex: 1,
                    marginRight: '8px'
                  }}>
                    {isEditing ? (
                      <div onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            fontSize: '13px',
                            marginBottom: '6px'
                          }}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button
                            onClick={() => saveRename(corpus.id)}
                            style={{
                              padding: '4px 8px',
                              backgroundColor: '#11074A',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '11px',
                              cursor: 'pointer'
                            }}
                          >
                            Save
                          </button>
                          <button
                            onClick={cancelEditing}
                            style={{
                              padding: '4px 8px',
                              backgroundColor: '#6c757d',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              fontSize: '11px',
                              cursor: 'pointer'
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      corpus.displayName
                    )}
                  </div>
                  {!isEditing && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={(e) => startEditing(corpus, e)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '2px 6px',
                          color: '#6c757d',
                          fontSize: '11px',
                          textDecoration: 'underline'
                        }}
                      >
                        Rename
                      </button>
                      <button
                        onClick={(e) => deleteCorpus(corpus.id, e)}
                        disabled={deleting === corpus.id}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '2px 6px',
                          color: '#dc3545',
                          fontSize: '11px',
                          textDecoration: 'underline',
                          opacity: deleting === corpus.id ? 0.5 : 1
                        }}
                      >
                        {deleting === corpus.id ? 'Deleting...' : 'Delete'}
                      </button>
                      <span style={{ 
                        fontSize: '14px',
                        color: isSelected ? '#11074A' : '#999'
                      }}>
                        {isSelected ? '✓' : '+'}
                      </span>
                    </div>
                  )}
                </div>

                {!isEditing && (
                  <>
                    <div style={{
                      fontSize: '11px',
                      color: '#666',
                      marginBottom: '4px'
                    }}>
                      📁 {corpus.source.folderName} • {corpus.files.length} files
                    </div>

                    <div style={{
                      fontSize: '10px',
                      color: '#999'
                    }}>
                      Created: {new Date(corpus.createdAt).toLocaleDateString()}
                    </div>
                  </>
                )}
              </div>
            );
          })}

          {selectedCorpora.size > 0 && (
            <div style={{
              marginTop: '12px',
              padding: '8px',
              backgroundColor: '#d4edda',
              border: '1px solid #c3e6cb',
              borderRadius: '4px',
              color: '#155724',
              fontSize: '12px',
              fontWeight: '500',
              textAlign: 'center'
            }}>
              {selectedCorpora.size} corpus selected
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface KnowledgeTabsProps {
  activeTab: 'collections' | 'files' | 'rag' | 'papers';
  onTabChange: (tab: 'collections' | 'files' | 'rag' | 'papers') => void;
  hiddenTabs?: Array<'collections' | 'files' | 'rag' | 'papers'>;
}

type KnowledgeTabId = 'collections' | 'files' | 'rag' | 'papers';
const ALL_KNOWLEDGE_TABS: { id: KnowledgeTabId; label: string }[] = [
  { id: 'collections', label: 'Collections' },
  { id: 'files', label: 'Files' },
  { id: 'rag', label: 'RAG' },
  { id: 'papers', label: 'Papers' },
];

const KnowledgeTabs: React.FC<KnowledgeTabsProps> = ({ activeTab, onTabChange, hiddenTabs = [] }) => {
  const tabs = ALL_KNOWLEDGE_TABS.filter(t => !hiddenTabs.includes(t.id));

  return (
    <div className="knowledge-tabs">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          className={`knowledge-tab ${activeTab === id ? 'active' : ''}`}
          onClick={() => onTabChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

export default function ListExtracts({ onContextUpdate, onAgentFilesUpdate, onAgentPapersUpdate, onAgentRagUpdate, hiddenTabs = [] }: ListExtractsProps) {
  const { collections } = useCollectionContext();
  const { session } = useSharedSession();
  const { token: globalToken, projectFolder } = useProjectState();
  const token = session?.accessToken || globalToken || "";

  const [extractFolders, setExtractFolders] = useState<Folder[]>([]);
  const [folderFiles, setFolderFiles] = useState<{ [key: string]: FileItem[] }>({});
  const [fileContent, setFileContent] = useState<{ [key: string]: string }>({});
  const [context, setContext] = useState<string>("");
  const [masterExtract, setMasterExtract] = useState<Extract[]>([]);
  const [isPopupOpen, setIsPopupOpen] = useState<boolean>(false);
  const [selectedPages, setSelectedPages] = useState<Set<UniquePageId>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const { setMasterContextString } = useMasterContext();
  const [isDownloading, setIsDownloading] = useState(false);
  const [isCollectionPopupOpen, setIsCollectionPopupOpen] = useState<boolean>(false);
  const [selectedCollectionIndex, setSelectedCollectionIndex] = useState<number | null>(null);
  const [rangeInputs, setRangeInputs] = useState<{ [folderId: string]: { start: string; end: string } }>({});
  const [showHowlChat, setShowHowlChat] = useState(false);

  const [selectedAgentFiles, setSelectedAgentFiles] = useState<SelectedFile[]>([]);

  const [selectedAgentPapers, setSelectedAgentPapers] = useState<SelectedPaper[]>([]);


  const [_selectedAgentRag, setSelectedAgentRag] = useState<SelectedRag[]>([]);

  const [activeKnowledgeTab, setActiveKnowledgeTab] = useState<'collections' | 'files' | 'rag' | 'papers'>('files');

  useEffect(() => {
    if (hiddenTabs.includes(activeKnowledgeTab)) {
      const visible = (['collections', 'files', 'rag', 'papers'] as const).filter(t => !hiddenTabs.includes(t));
      setActiveKnowledgeTab(visible[0] || 'collections');
    }
  }, [hiddenTabs, activeKnowledgeTab]);

  function handleRangeChange(
    folderId: string,
    field: "start" | "end",
    value: string
  ) {
    setRangeInputs(prev => ({
      ...prev,
      [folderId]: {
        start: field === "start" ? value : prev[folderId]?.start || "",
        end: field === "end" ? value : prev[folderId]?.end || "",
      }
    }));
  }

  async function selectRange(
    folderId: string,
    pdfName: string
  ) {
    if (!projectFolder?.projectId || !token || isDownloading) return;

    const files = dedupFiles(folderFiles[folderId] || []);
    const { start, end } = rangeInputs[folderId] || { start: "", end: "" };
    const startNum = parseInt(start, 10);
    const endNum = parseInt(end, 10);
    if (
      isNaN(startNum) ||
      isNaN(endNum) ||
      startNum > endNum
    ) return;

    const sortedFiles = files.sort((a, b) => {
      const pageA = parseInt(a.name.split(".")[0]) || 0;
      const pageB = parseInt(b.name.split(".")[0]) || 0;
      return pageA - pageB;
    });

    const rangeFiles = sortedFiles.filter(file => {
      const pageNumber = parseInt(file.name.split(".")[0], 10);
      return pageNumber >= startNum && pageNumber <= endNum;
    });

    if (rangeFiles.length > 0) {
      setIsDownloading(true);

      for (const file of rangeFiles) {
        const pageNumber = parseInt(file.name.split(".")[0], 10);
        await togglePageSelection(
          file.id,
          file.name,
          String(pageNumber),
          pdfName
        );
      }

      setIsDownloading(false);
    }
  }

  const closeCollectionPopup = () => {
    setIsCollectionPopupOpen(false);
    setSelectedCollectionIndex(null);
  };

  const handleAgentFilesSelected = (files: SelectedFile[]) => {
    setSelectedAgentFiles(files);
    console.log('Selected agent files:', files);

    onAgentFilesUpdate?.(files);

    if (files.length > 0) {
      const filesList = files.map(f => `- ${f.name} (${f.folderName})`).join('\n');
      const filesContext = `Selected Project Files:\n${filesList}\n\nThese files are available for processing in agents.`;

      onContextUpdate(context + '\n\n' + filesContext);
    }
  };

  const handleAgentPapersSelected = (papers: SelectedPaper[]) => {
    setSelectedAgentPapers(papers);
    console.log('Selected scientific papers:', papers);

    onAgentPapersUpdate?.(papers);

    if (papers.length > 0) {
      const papersList = papers.map(p => `- ${p.title} (${p.authors.join(', ')}) - ${p.pubdate}`).join('\n');
      const papersContext = `Selected Scientific Papers:\n${papersList}\n\nThese papers and their abstracts are available for processing in agents.`;

      onContextUpdate(context + '\n\n' + papersContext);
    }
  };

  const handleAgentRagSelected = useCallback((ragItems: SelectedRag[]) => {
    setSelectedAgentRag(ragItems);
    console.log('Selected RAG items:', ragItems);

    onAgentRagUpdate?.(ragItems);

    if (ragItems.length > 0) {
      const ragList = ragItems.map(r => `- ${r.filename} (${r.theme}) - ${r.description}`).join('\n');
      const ragContext = `Selected RAG Knowledge Items:\n${ragList}\n\nThese knowledge items and their chunks are available for processing in agents.`;

      onContextUpdate(context + '\n\n' + ragContext);
    }
  }, [onAgentRagUpdate, onContextUpdate, context]);

  useEffect(() => {
    const newMasterExtractString = masterExtract
      .map(
        (item) =>
          `% Page: ${item.pageNumber}, PDF: ${item.PDFName}, Collection: ${item.collection}\n${item.content}`
      )
      .join("\n");
    setMasterContextString(newMasterExtractString);
  }, [masterExtract, setMasterContextString]);

  const fetchExtractFolders = async (projectId: string) => {
    const url = `/api/projects/${projectId}/folders/Extracts/files`;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data.files.map((f: Folder) => ({ id: f.id, name: f.name }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(error);
        alert(error.message);
      } else {
        console.error("Unexpected error", error);
        alert("Unexpected error");
      }
      return [];
    }
  };

  useEffect(() => {
    if (projectFolder?.projectId) {
      fetchExtractFolders(projectFolder.projectId).then(setExtractFolders);
    }
  }, [projectFolder, token]);

  const fetchFileContent = async (token: string, projectId: string, fileId: string) => {
    const cacheKey = `fileContent_${fileId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;
    const url = `/api/projects/${projectId}/files/${fileId}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    localStorage.setItem(cacheKey, data.content);
    return data.content;
  };

  const refreshDataFromGoogleDrive = async () => {
    if (!projectFolder?.projectId || !token) {
      console.warn('Cannot refresh: missing project or token');
      return;
    }

    try {
      console.log('🔄 Refreshing extract folders from Google Drive...');

      const freshFolders = await fetchExtractFolders(projectFolder.projectId);
      setExtractFolders(freshFolders);

      const expandedFolderArray = Array.from(expandedFolders);
      if (expandedFolderArray.length > 0) {
        console.log(`🔄 Refreshing files for ${expandedFolderArray.length} expanded folders...`);

        const newFolderFiles: { [key: string]: FileItem[] } = {};
        await Promise.all(
          expandedFolderArray.map(async (folderId) => {
            try {
              const response = await fetch(
                `/api/projects/${projectFolder.projectId}/folders/folder_id/${folderId}/contents`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              const data = await response.json();
              if (!response.ok) throw new Error(data.error);
              newFolderFiles[folderId] = data.files;
            } catch (error) {
              console.error(`Error refreshing files for folder ${folderId}:`, error);
              newFolderFiles[folderId] = folderFiles[folderId] || [];
            }
          })
        );

        setFolderFiles(newFolderFiles);
      }

      console.log('✅ Google Drive data refresh completed');
    } catch (error) {
      console.error('❌ Error refreshing Google Drive data:', error);
      throw error;
    }
  };

  const togglePageSelection = async (
    fileId: string,
    fileName: string,
    pageNumber: string,
    pdfName: string
  ) => {
    if (!projectFolder?.projectId || !token) return;
    const uniquePageId: UniquePageId = `${fileId}-${pageNumber}`;
    const isSelecting = !selectedPages.has(uniquePageId);

    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (isSelecting) {
        next.add(uniquePageId);
      } else {
        next.delete(uniquePageId);
      }
      return next;
    });

    if (isSelecting) {
      const content = await fetchFileContent(token, projectFolder.projectId, fileId);
      setMasterExtract((prev) => [
        ...prev,
        { fileId, fileName, pageNumber, content, PDFName: pdfName },
      ]);
      setContext((prev) => `${prev}\n${content}`);
      setFileContent((prev) => ({ ...prev, [fileId]: content }));
    } else {
      setMasterExtract((prev) =>
        prev.filter((item) => item.fileId !== fileId || item.pageNumber !== pageNumber)
      );
      setContext((prev) => {
        const contentToRemove = fileContent[fileId] || "";
        return prev.replace(contentToRemove, "").trim();
      });
    }
  };

  const selectAllPages = async (folderId: string, pdfName: string) => {
    const files = folderFiles[folderId] || [];
    const dedupedFiles = dedupFiles(files).sort((a, b) => {
      const pageA = parseInt(a.name.split(".")[0]) || 0;
      const pageB = parseInt(b.name.split(".")[0]) || 0;
      return pageA - pageB;
    });
    const newSelectedPages = new Set<UniquePageId>(selectedPages);
    const allSelected = dedupedFiles.every(
      (file) =>
        newSelectedPages.has(`${file.id}-${file.name.split(".")[0]}` as UniquePageId)
    );

    if (!allSelected) {
      setIsDownloading(true);

      await Promise.all(
        dedupedFiles.map(async (file) => {
          const pageNumber = file.name.split(".")[0];
          const uniquePageId: UniquePageId = `${file.id}-${pageNumber}`;
          newSelectedPages.add(uniquePageId);
          const exists = masterExtract.some(
            (ex) => ex.fileId === file.id && ex.pageNumber === pageNumber
          );
          if (!exists) {
            const content = await fetchFileContent(token, projectFolder!.projectId, file.id);
            setMasterExtract((prev) => [
              ...prev,
              { fileId: file.id, fileName: file.name, pageNumber, content, PDFName: pdfName },
            ]);
            setContext((prev) => `${prev}\n${content}`);
          }
        })
      );
      setSelectedPages(newSelectedPages);
      setIsDownloading(false);
    } else {
      for (const file of dedupedFiles) {
        newSelectedPages.delete(`${file.id}-${file.name.split(".")[0]}` as UniquePageId);
      }
      setSelectedPages(newSelectedPages);
      setMasterExtract((prev) =>
        prev.filter((item) => !dedupedFiles.some((f) => f.id === item.fileId))
      );
      setContext(
        dedupedFiles.reduce(
          (acc, file) => acc.replace(fileContent[file.id] || "", "").trim(),
          context
        )
      );
    }
  };

  const toggleFolder = async (folderId: string) => {
    if (!expandedFolders.has(folderId) && projectFolder?.projectId && token) {
      const response = await fetch(
        `/api/projects/${projectFolder.projectId}/folders/folder_id/${folderId}/contents`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setFolderFiles((prev) => ({ ...prev, [folderId]: data.files }));
    }
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const clearContext = () => {
    setContext("");
    setSelectedPages(new Set());
    setMasterExtract([]);
    setIsPopupOpen(false);
    onContextUpdate("");
  };

  if (!token) return <p>No token available.</p>;

  return (
    <>
      {}
      <div className="knowledge-header">
        <h2 className="knowledge-title">Knowledge Management</h2>
        <div className="knowledge-actions">
          {}
          <div
            className={styles.popupIcon}
            onClick={() => setIsPopupOpen((v) => !v)}
            style={{ cursor: "pointer" }}
          >
            <FaEye title="Check Context" />
          </div>

          {}
          {masterExtract.length > 0 && (
            <div
              className={styles.popupIcon}
              onClick={() => setShowHowlChat((v) => !v)}
              style={{ cursor: "pointer" }}
            >
              <img
                src="/images/dark fav private/apple-icon.png"
                alt="Chat"
                title="Chat with Alma"
                style={{ width: "100%", height: "100%" }}
              />
            </div>
          )}
        </div>
      </div>

      {}
      <KnowledgeTabs
        activeTab={activeKnowledgeTab}
        onTabChange={setActiveKnowledgeTab}
        hiddenTabs={hiddenTabs}
      />

      {}
      <div className="knowledge-content">
        {}
        {activeKnowledgeTab === 'collections' && (
          <div className="collections-view">
            <CollectionManager
              masterExtract={masterExtract}
              setMasterExtract={setMasterExtract}
              setSelectedPages={setSelectedPages}
              setContext={setContext}
              onContextUpdate={onContextUpdate}
              setSelectedCollectionIndex={setSelectedCollectionIndex}
              isDownloading={isDownloading}
              onRefreshData={refreshDataFromGoogleDrive}
            />

            {extractFolders.length > 0 ? (
              extractFolders.map((folder) => {
                const files = folderFiles[folder.id] || [];
                const dedupedFiles = dedupFiles(files).sort((a, b) => {
                  const pageA = parseInt(a.name.split(".")[0]) || 0;
                  const pageB = parseInt(b.name.split(".")[0]) || 0;
                  return pageA - pageB;
                });
                const allPagesSelected =
                  dedupedFiles.length > 0 &&
                  dedupedFiles.every((file) =>
                    selectedPages.has(`${file.id}-${file.name.split(".")[0]}` as UniquePageId)
                  );

                return (
                  <div
                    key={folder.id}
                    className={`${styles.folderContainer} ${allPagesSelected ? "all-selected" : ""}`}
                    data-folder-id={folder.id}
                  >
                    <div className={styles.folderHeader} onClick={() => toggleFolder(folder.id)}>
                      {expandedFolders.has(folder.id) ? <FaChevronUp /> : <FaChevronDown />}
                      <span className={styles.folderName} title={folder.name}>{folder.name}</span>
                    </div>
                    {expandedFolders.has(folder.id) && (
                      <div className={styles.folderContent}>
                        {}
                        <button
                          disabled={isDownloading}
                          className={styles.refreshButton}
                          onClick={() => selectAllPages(folder.id, folder.name)}
                        >
                          {allPagesSelected ? "Deselect All" : "Select All"}
                        </button>

                        {}
                        <div className={styles.rangeSelector}>
                          <div className={styles.rangeInputsRow}>
                            <label>From</label>
                            <input
                              type="number"
                              min={1}
                              disabled={isDownloading}
                              value={rangeInputs[folder.id]?.start || ""}
                              onChange={(e) =>
                                handleRangeChange(folder.id, "start", e.target.value)
                              }
                            />
                            <label>To</label>
                            <input
                              type="number"
                              min={1}
                              disabled={isDownloading}
                              value={rangeInputs[folder.id]?.end || ""}
                              onChange={(e) =>
                                handleRangeChange(folder.id, "end", e.target.value)
                              }
                            />
                          </div>
                          <button
                            disabled={
                              isDownloading ||
                              !rangeInputs[folder.id] ||
                              parseInt(rangeInputs[folder.id].start, 10) >
                              parseInt(rangeInputs[folder.id].end, 10)
                            }
                            className={styles.projectButton}
                            onClick={() => selectRange(folder.id, folder.name)}
                          >
                            Select
                          </button>
                        </div>

                        {}
                        {isDownloading && (
                          <div className={styles.loadingIndicator}>
                            <FaSyncAlt className={styles.spin} /> Loading pages...
                          </div>
                        )}

                        {}
                        {dedupedFiles
                          .sort((a, b) => {
                            const pageA = parseInt(a.name.split(".")[0]) || 0;
                            const pageB = parseInt(b.name.split(".")[0]) || 0;
                            return pageA - pageB;
                          })
                          .map((file) => {
                            const pageNumber = file.name.split(".")[0];
                            const uniquePageId = `${file.id}-${pageNumber}` as UniquePageId;
                            return (
                              <button
                                disabled={isDownloading}
                                key={file.id}
                                onClick={() =>
                                  togglePageSelection(file.id, file.name, pageNumber, folder.name)
                                }
                                className={`${styles.pageButtonSmall} ${selectedPages.has(uniquePageId) ? styles.selected : ""
                                  }`}
                              >
                                {pageNumber}
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <p>No extract folders found.</p>
            )}
          </div>
        )}

        {}
        {activeKnowledgeTab === 'files' && (
          <div className="files-view">
            <ProjectFilePicker
              onFilesSelected={handleAgentFilesSelected}
              selectedFiles={selectedAgentFiles}
            />
          </div>
        )}

        {}
        {activeKnowledgeTab === 'rag' && (
          <div className="rag-view">
            <RAGKnowledgeSection
              onRagSelected={handleAgentRagSelected}
            />
          </div>
        )}

        {}
        {activeKnowledgeTab === 'papers' && (
          <div className="papers-view">
            <ScientificPaperSearch
              onPapersSelected={handleAgentPapersSelected}
              selectedPapers={selectedAgentPapers}
            />
          </div>
        )}
      </div>

      {}
      {ReactDOM.createPortal(
        <Popup
          isOpen={isPopupOpen}
          onClose={() => setIsPopupOpen(false)}
          masterExtract={masterExtract}
          onClear={clearContext}
          onTogglePage={(fileId, fileName, pageNumber) =>
            togglePageSelection(fileId, fileName, pageNumber, "")
          }
        />,
        document.body
      )}
      {isCollectionPopupOpen && selectedCollectionIndex !== null && ReactDOM.createPortal(
        <CollectionPopup
          isOpen={isCollectionPopupOpen}
          onClose={closeCollectionPopup}
          collection={collections[selectedCollectionIndex].map((ex) => ({
            fileId: ex.fileId,
            pageNumber: ex.pageNumber,
            content: ex.content,
            fileName: ex.fileName,
            pdfName: ex.PDFName,
          }))}
          collectionIndex={selectedCollectionIndex}
        />,
        document.body
      )}

      {}
      {showHowlChat && ReactDOM.createPortal(
        <HowlChat
          initialPrompt={context}
          onClose={() => setShowHowlChat(false)}
        />,
        document.body
      )}
    </>
  );

}
