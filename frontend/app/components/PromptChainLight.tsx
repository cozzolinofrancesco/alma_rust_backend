'use client';
import React, { useState, useEffect, useMemo, useRef } from "react";
import { useCollectionContext } from "./CollectionContext";
import AgentChain, { AgentChainProps, SelectedFile } from "./AgentChain";
import { SelectedPaper } from "./ScientificPaperSearch";
import { useSession } from "next-auth/react";
import { useProjectState } from "./ProjectStateContext";
import { FaChevronDown, FaSync, FaDownload, FaUpload } from "react-icons/fa";
import "../styles/createAgents.css";

interface AgentFile {
  id: string;
  name: string;
  mimeType: string;
}

type Layers = NonNullable<AgentChainProps['initialLayers']>;

type JsonPrimitive = string | number | boolean | null;

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonArray = JsonValue[];

type JsonValue = JsonPrimitive | JsonObject | JsonArray;

interface AgentSpecificProperties {
  layers?: Layers;
}

interface OtherJsonProperties {
  [key: string]: JsonValue;
}

type ParsedAgentJson = AgentSpecificProperties & OtherJsonProperties;

interface AgentMetadataProperties {
  userEmail?: string;
  createdDate?: string;
}

type AgentJsonWithMetadata = ParsedAgentJson & AgentMetadataProperties;

const JsonViewer: React.FC<{ jsonObject: JsonValue }> = ({ jsonObject }) => {

  const renderNode = (value: JsonValue, depth: number): JSX.Element => {
    if (value === null) {
      return <span className="json-null">null</span>;
    }
    if (typeof value === 'boolean') {
      return <span className="json-boolean">{String(value)}</span>;
    }
    if (typeof value === 'number') {
      return <span className="json-number">{String(value)}</span>;
    }
    if (typeof value === 'string') {
      const escapedString = value.replace(/"/g, '\\"');
      return <span className="json-string">"{escapedString}"</span>;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <span>[]</span>;
      }
      return (
        <>
          <span>[</span>
          {value.map((item, index) => (
            <div key={index} style={{ paddingLeft: `${(depth + 1) * 20}px` }}>
              {renderNode(item, depth + 1)}
              {index < value.length - 1 ? ',' : ''}
            </div>
          ))}
          <span style={{ paddingLeft: `${depth * 20}px` }}>]</span>
        </>
      );
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        return <span>{}</span>;
      }
      return (
        <>
          <span>{'{'}</span>
          {keys.map((k, index) => (
            <div key={k} style={{ paddingLeft: `${(depth + 1) * 20}px` }}>
              <span className="json-key">"{k}"</span>: {renderNode(value[k], depth + 1)}
              {index < keys.length - 1 ? ',' : ''}
            </div>
          ))}
          <span style={{ paddingLeft: `${depth * 20}px` }}>{'}'}</span>
        </>
      );
    }

    return <span>{String(value)}</span>;
  };

  if (typeof jsonObject !== 'object' || jsonObject === null) {
     return <div className="json-viewer-root">{renderNode(jsonObject, 0)}</div>;
  }

  if (Array.isArray(jsonObject)) {
       if (jsonObject.length === 0) {
        return <div className="json-viewer-root">[]</div>;
      }
      return (
        <div className="json-viewer-root">
          <span>[</span>
          {jsonObject.map((item, index) => (
            <div key={index} style={{ paddingLeft: `20px` }}>
              {renderNode(item, 1)}
              {index < jsonObject.length - 1 ? ',' : ''}
            </div>
          ))}
          <span>]</span>
        </div>
      );
  }

  const rootKeys = Object.keys(jsonObject);
  if (rootKeys.length === 0) {
    return <div className="json-viewer-root">{}</div>;
  }

  return (
    <div className="json-viewer-root">
      <span>{'{'}</span>
      {rootKeys.map((k, index) => (
        <div key={k} style={{ paddingLeft: `20px` }}>
          <span className="json-key">"{k}"</span>: {renderNode(jsonObject[k], 1)}
          {index < rootKeys.length - 1 ? ',' : ''}
        </div>
      ))}
      <span>{'}'}</span>
    </div>
  );
};

interface PromptChainLightProps {
  masterContext: string;
  agentName: string;
  selectedFiles?: SelectedFile[];
  selectedPapers?: SelectedPaper[];
}

export default function PromptChainLight({
  masterContext,
  agentName,
  selectedFiles,
  selectedPapers,
}: PromptChainLightProps) {
  const { collections } = useCollectionContext();
  const { data: session } = useSession();
  const { token: globalToken, projectFolder } = useProjectState();
  const token = session?.accessToken || globalToken || "";

  const DEFAULT_ID = "1";
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([
    { id: DEFAULT_ID, name: agentName },
  ]);
  const [importedLayers, setImportedLayers] = useState<
    Record<string, Layers | undefined>
  >({});

  const [drawerOpen, setDrawerOpen] = useState(true);
  const [agentFiles, setAgentFiles] = useState<AgentFile[]>([] as AgentFile[]);
  const [reloadAgentListTrigger, setReloadAgentListTrigger] = useState(0);

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalFile, setModalFile] = useState<AgentFile | null>(null);
  const [modalParsedContent, setModalParsedContent] = useState<AgentJsonWithMetadata | JsonValue | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [systemInstructionsPrompt, setSystemInstructionsPrompt] = useState<string>("");
  const [clearInstructionsTrigger, setClearInstructionsTrigger] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentMasterContext = useMemo(() => {
      if (!systemInstructionsPrompt) {
          return masterContext;
      }
      return `${masterContext}\n\n--- System Instructions ---\n${systemInstructionsPrompt}`;
  }, [masterContext, systemInstructionsPrompt]);

  useEffect(() => {
    if (!projectFolder?.projectId) return;
    fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) {
          if (r.status === 404) {
             console.warn("Agent files folder (AF) not found or is empty.");
             return { files: [] };
          }
          throw new Error(`HTTP error! status: ${r.status}`);
        }
        return r.json();
      })
      .then((data: { files?: AgentFile[] }) => setAgentFiles(data.files || []))
      .catch((error) => {
        console.error("Failed to fetch agent files:", error);
        setAgentFiles([]);
      });
  }, [projectFolder, token, reloadAgentListTrigger]);

  const handleReloadAgentList = () => {
      setReloadAgentListTrigger(prev => prev + 1);
      setExpandedFile(null);
      closeModal();
      setFileContents({});
  };

  const handleLoadAgent = async (file: AgentFile) => {
    if (!projectFolder?.projectId) {
        alert("Project not loaded.");
        return;
    }
    try {
      const res = await fetch(
        `/api/projects/${projectFolder.projectId}/files/${file.id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const json: { content: string } = await res.json();

      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(json.content);
      } catch {
        alert("Invalid JSON format in file.");
        return;
      }

      const { isVersionedAgent, getCurrentVersionLayers } = await import('../lib/versionUtils');
      
      let layers: unknown[];
      let agentName: string;
      
      if (isVersionedAgent(parsedRaw)) {
        layers = getCurrentVersionLayers(parsedRaw);
        agentName = parsedRaw.agentName;
        console.log(`Loading versioned agent: ${agentName}, current version: ${parsedRaw.currentVersion}`);
      } else {
        if (
          typeof parsedRaw !== "object" ||
          parsedRaw === null ||
          !('layers' in parsedRaw) ||
          !Array.isArray((parsedRaw as ParsedAgentJson).layers)
        ) {
          alert("File does not contain a valid 'layers' array.");
          return;
        }
        
        const agentData = parsedRaw as ParsedAgentJson;
        layers = agentData.layers as Layers;
        agentName = String(agentData.name) || file.name.replace(/\.json$/i, "");
      }

      setAgents([{ id: file.id, name: agentName }]);
      setImportedLayers({ [file.id]: layers as Layers });
      setFileContents((fc) => ({ ...fc, [file.id]: json.content }));
      setExpandedFile(null);
      setDrawerOpen(false);
      closeModal();

      setClearInstructionsTrigger(prev => prev + 1);

    } catch (error) {
      console.error("Failed to load agent file:", error);
      alert("Failed to load agent file.");
    }
  };

  const togglePreview = async (file: AgentFile) => {
    if (expandedFile === file.id) {
      setExpandedFile(null);
      return;
    }
    setExpandedFile(file.id);
    if (!fileContents[file.id] || fileContents[file.id] === "Error loading content.") {
        if (!projectFolder?.projectId) {
            setFileContents((fc) => ({ ...fc, [file.id]: "Project not loaded." }));
            return;
        }
      try {
        const res = await fetch(
          `/api/projects/${projectFolder.projectId}/files/${file.id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const json: { content: string } = await res.json();
        setFileContents((fc) => ({ ...fc, [file.id]: json.content }));
      } catch (error) {
        console.error("Failed to fetch file content for inline preview:", error);
        setFileContents((fc) => ({ ...fc, [file.id]: "Error loading content." }));
      }
    }
  };

  const handleViewJson = async (file: AgentFile) => {
    if (!projectFolder?.projectId) {
        alert("Project not loaded.");
        return;
    }

    let content = fileContents[file.id];

    if (!content || content === "Error loading content.") {
      try {
        const res = await fetch(
          `/api/projects/${projectFolder.projectId}/files/${file.id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const json: { content: string } = await res.json();
        content = json.content;
        setFileContents((fc) => ({ ...fc, [file.id]: content }));
      } catch (error) {
        console.error("Failed to fetch file content for modal:", error);
        alert("Failed to load file content.");
        return;
      }
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse JSON for modal display:", e);
      setModalFile(file);
      setModalParsedContent("Error: Invalid JSON format.");
      setIsModalOpen(true);
      return;
    }

    let finalJsonForDisplay: AgentJsonWithMetadata | JsonValue;

    if (typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson)) {
        const objWithMetadata: AgentJsonWithMetadata = parsedJson as ParsedAgentJson;
        objWithMetadata.userEmail = session?.user?.email || 'N/A';
        objWithMetadata.createdDate = 'Not available from API';
        finalJsonForDisplay = objWithMetadata;
    } else {
         console.warn("Parsed JSON is not an object, displaying as is:", parsedJson);
         finalJsonForDisplay = parsedJson as JsonValue;
    }

    setModalFile(file);
    setModalParsedContent(finalJsonForDisplay);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setModalFile(null);
    setModalParsedContent(null);
  };

  const handleDownloadAgent = async (file: AgentFile) => {
    if (!projectFolder?.projectId) {
        alert("Project not loaded.");
        return;
    }
    try {
      let content = fileContents[file.id];
      if (!content || content === "Error loading content.") {
          const res = await fetch(
            `/api/projects/${projectFolder.projectId}/files/${file.id}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const json: { content: string } = await res.json();
          content = json.content;
          setFileContents((fc) => ({ ...fc, [file.id]: content }));
      }

      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("Failed to download agent file:", error);
      alert("Failed to download agent file.");
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleUploadAgent(file);
    }
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  const handleUploadAgent = async (file: File) => {
    if (!projectFolder?.projectId) {
        alert("Project not loaded.");
        return;
    }

    if (file.type !== 'application/json') {
        alert("Please upload a JSON file.");
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const content = e.target?.result as string;

      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(content);
      } catch {
        alert("Invalid JSON format in the uploaded file.");
        return;
      }

      if (
        typeof parsedContent !== "object" ||
        parsedContent === null ||
        !('layers' in parsedContent) ||
        !Array.isArray((parsedContent as ParsedAgentJson).layers)
      ) {
        alert("Uploaded file does not contain a valid 'layers' array.");
        return;
      }

      try {
        const formData = new FormData();
        formData.append('file', file);

        const uploadRes = await fetch(`/api/projects/${projectFolder.projectId}/folders/AF/files`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
          body: formData,
        });

        if (!uploadRes.ok) {
            let serverMessage = `Upload failed: Server responded with ${uploadRes.status}`;
            try {
                const errorData = await uploadRes.json();
                serverMessage = errorData.error || errorData.message || serverMessage;
            } catch {
                const textResponse = await uploadRes.text().catch(() => null);
                if (textResponse) {
                    serverMessage = textResponse;
                } else if (uploadRes.statusText) {
                    serverMessage = `Upload failed: ${uploadRes.statusText}`;
                }
            }
            throw new Error(serverMessage);
        }

        alert(`Agent "${file.name}" uploaded successfully.`);
        handleReloadAgentList();

      } catch (error) {
        console.error("Failed to upload agent file:", error);
        alert(`Failed to upload agent file: ${(error as Error).message}`);
      }
    };

    reader.onerror = (error) => {
      console.error("FileReader error:", error);
      alert("Error reading the file.");
    };

    reader.readAsText(file);
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="promptchain-container">
      <div className={`editor-wrapper ${drawerOpen ? "shifted" : ""}`}>

        {}
        {agents.map((agent) => (
          <AgentChain
            key={agent.id}
            id={agent.id}
            initialName={agent.name}
            masterContext={currentMasterContext}
            collections={collections}
            initialLayers={importedLayers[agent.id]}
            onNameChange={(id, newName) =>
              setAgents((prev) =>
                prev.map((a) => (a.id === id ? { ...a, name: newName } : a))
              )
            }
            clearInstructionsTrigger={clearInstructionsTrigger}
            selectedFiles={selectedFiles}
            selectedPapers={selectedPapers}
          />
        ))}
      </div>

      {}
      <div className="saved-agents-container">
        <button
          className={`saved-agents-button ${drawerOpen ? "active" : ""}`}
          onClick={() => setDrawerOpen((o) => !o)}
          aria-label={drawerOpen ? "Close saved agents menu" : "Open saved agents menu"}
        >
          <FaChevronDown className={`dropdown-icon ${drawerOpen ? "rotated" : ""}`} />
          Saved Agents
        </button>

        {drawerOpen && (
          <div className="agents-dropdown-menu">
            <div className="dropdown-header">
              <div className="dropdown-actions">
                <button
                    className="reload-list-button"
                    onClick={handleReloadAgentList}
                    title="Reload agent list"
                    aria-label="Reload agent list"
                >
                    <FaSync />
                </button>
                {}
                <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: 'none' }}
                    accept=".json"
                    onChange={handleFileSelect}
                />
                {}
                <button
                    className="upload-button"
                    onClick={triggerFileUpload}
                    title="Upload agent file"
                    aria-label="Upload agent file"
                >
                    <FaUpload /> Upload
                </button>
              </div>
            </div>

            <div className="dropdown-content">
              {agentFiles.length === 0 ? (
                <p className="no-agents-message">No saved agents found.</p>
              ) : (
                agentFiles.map((file) => (
                  <div key={file.id} className="agent-detail">
                    <div className="agent-name-row" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <h5
                        style={{ cursor: "pointer", margin: 0, flexGrow: 1 }}
                        onClick={() => togglePreview(file)}
                      >
                        {file.name.replace(/\.json$/i, "")}
                      </h5>
                      <span
                          className="view-json-brackets"
                          onClick={() => handleViewJson(file)}
                          style={{
                              cursor: "pointer",
                          }}
                          title={`View JSON for ${file.name.replace(/\.json$/i, "")}`}
                      >
                          [ ]
                      </span>
                      {}
                      <button
                          className="icon-button"
                          onClick={() => handleDownloadAgent(file)}
                          title={`Download ${file.name.replace(/\.json$/i, "")}`}
                          aria-label={`Download ${file.name.replace(/\.json$/i, "")}`}
                      >
                          <FaDownload />
                      </button>
                    </div>

                    {expandedFile === file.id && fileContents[file.id] && (
                      <pre className="agent-preview">
                        {fileContents[file.id]}
                      </pre>
                    )}
                    <button
                      className="load-button"
                      onClick={() => handleLoadAgent(file)}
                    >
                      Load
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {isModalOpen && modalFile && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h4>{modalFile.name.replace(/\.json$/i, "")} JSON</h4>
              <button className="close-button" onClick={closeModal} aria-label="Close modal">&times;</button>
            </div>
            <div className="modal-body">
              {modalParsedContent !== null ? (
                 typeof modalParsedContent === 'string' ? (
                     <pre>{modalParsedContent}</pre>
                 ) : (
                     <JsonViewer jsonObject={modalParsedContent} />
                 )
              ) : (
                 <div>Loading JSON...</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

if (typeof window === 'undefined' && typeof global.File === 'undefined') {
  const { File } = await import('fetch-blob/file.js');
  global.File = File;
}
