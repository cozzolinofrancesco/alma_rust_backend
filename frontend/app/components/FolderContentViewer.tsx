"use client";
import { useModels } from '../hooks/useModels';
import { MathJaxContext } from "better-react-mathjax";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { FaChevronDown, FaChevronUp, FaSyncAlt } from "react-icons/fa";
import ReactMarkdown from "react-markdown";
import { DEFAULT_MODEL } from '../lib/modelConfig';
import { useCollectionContext } from "./CollectionContext";
import { useProjectState } from "./ProjectStateContext";

interface ExtractItem {
  id: string;
  name: string;
  mimeType: string;
}

interface FileItem {
  id: string;
  name: string;
  mimeType: string;
}

export interface TreeNode {
  id: string;
  prompt?: string;
  condition?: string;
  result?: string;
  keepMaster?: boolean;
  children?: TreeNode[];
  collection?: number;
}

export interface FolderContentViewerProps {
  masterStringContext: string;
}

export default function FolderContentViewer({
  masterStringContext }: FolderContentViewerProps) {
    const models = useModels();
  const { collections } = useCollectionContext();
  const { data: session } = useSession();
  const { token: globalToken, projectFolder } = useProjectState();
  const token = session?.accessToken || globalToken || "";

  const [extractItems, setExtractItems] = useState<ExtractItem[]>([]);
  const [folderFiles, setFolderFiles] = useState<{ [key: string]: FileItem[] }>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [processedTree, setProcessedTree] = useState<TreeNode | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [expandedFileContents, setExpandedFileContents] = useState<Set<string>>(new Set());
  const [analysisRunning, setAnalysisRunning] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);


  if (!token) {
    console.log("❌ No token available. Please log in or provide a token.");
    return <p>No token available. Please log in or provide a token.</p>;
  }

  const fetchExtractItems = async (projectId: string) => {
    console.log(`🟢 [FetchExtractItems] Start fetching extract items for projectId: ${projectId}`);
    const folderName = "AF";
    const url = `/api/projects/${projectId}/folders/${folderName}/files`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Error fetching extract items");
      }
      const data = await response.json();
      const items = data.files as ExtractItem[];
      console.log(`✅ [FetchExtractItems] Fetched ${items.length} items.`);
      return items;
    } catch (error: unknown) {
      console.error(
        error instanceof Error
          ? `❌ [FetchExtractItems] Error: ${error.message}`
          : "❌ [FetchExtractItems] Unexpected error"
      );
      return [];
    }
  };

  const fetchCollectionContent = (collectionNumber: number): string => {
    const entries = collections[collectionNumber - 1] || [];
    const content = entries
      .map(
        (entry) =>
          `% Page ${entry.pageNumber}, PDF: ${entry.PDFName}\n${entry.content}`
      )
      .join("\n\n");
    return content;
  };

  const fetchFolderContents = async (folderId: string) => {
    console.log(`🟢 [FetchFolderContents] Start fetching folder contents for folderId: ${folderId}`);
    const url = `/api/folders/${folderId}/contents`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Error fetching folder contents");
      }
      const data = await response.json();
      const files = data.files as FileItem[];
      setFolderFiles((prev) => ({ ...prev, [folderId]: files }));
      console.log(`✅ [FetchFolderContents] Fetched ${files.length} files for folder ${folderId}.`);

      files.forEach((file) => {
        if (!fileContents[file.id] && projectFolder?.projectId) {
          console.log(`🟢 [FetchFolderContents] Fetching file content for fileId: ${file.id}`);
          fetchFileContent(projectFolder.projectId, file.id).then((content) => {
            setFileContents((prev) => ({ ...prev, [file.id]: content }));
            console.log(`✅ [FetchFolderContents] Fetched content for fileId: ${file.id}`);
          });
        }
      });
    } catch (error: unknown) {
      console.error(
        error instanceof Error
          ? `❌ [FetchFolderContents] Error: ${error.message}`
          : "❌ [FetchFolderContents] Unexpected error"
      );
    }
  };

  const fetchFileContent = async (projectId: string, fileId: string) => {
    console.log(`🟢 [FetchFileContent] Start fetching file content for fileId: ${fileId}`);
    const url = `/api/projects/${projectId}/files/${fileId}`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Error fetching file content");
      }
      const data = await response.json();
      console.log(`✅ [FetchFileContent] Successfully fetched content for fileId: ${fileId}`);
      return data.content || "";
    } catch {
      console.error("❌ [FetchFileContent] Unable to reach Gemini API.");
      return "";
    }
  };

  const toggleFileContent = (fileId: string) => {
    console.log(`🔄 [ToggleFileContent] Toggling file content for fileId: ${fileId}`);
    if (!fileContents[fileId] && projectFolder?.projectId) {
      fetchFileContent(projectFolder.projectId, fileId).then((content) => {
        setFileContents((prev) => ({ ...prev, [fileId]: content }));
        console.log(`✅ [ToggleFileContent] Fetched file content for fileId: ${fileId}`);
      });
    }
    setExpandedFileContents((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
        console.log(`🔽 [ToggleFileContent] Hiding file content for fileId: ${fileId}`);
      } else {
        newSet.add(fileId);
        console.log(`🔼 [ToggleFileContent] Showing file content for fileId: ${fileId}`);
      }
      return newSet;
    });
  };

  const handleRefreshExtractItems = async () => {
    console.log("🔄 [HandleRefreshExtractItems] Refreshing extract items...");
    if (!projectFolder?.projectId) {
      console.log("❌ [HandleRefreshExtractItems] No projectId available.");
      return;
    }
    const items = await fetchExtractItems(projectFolder.projectId);
    setExtractItems(items);
  };

  const toggleFolder = (folderId: string) => {
    console.log(`🔄 [ToggleFolder] Toggling folder ${folderId}`);
    setExpandedFolders((prev) => {
      const newExpanded = new Set(prev);
      if (newExpanded.has(folderId)) {
        newExpanded.delete(folderId);
        console.log(`🔽 [ToggleFolder] Collapsed folder ${folderId}`);
      } else {
        newExpanded.add(folderId);
        console.log(`🔼 [ToggleFolder] Expanded folder ${folderId}`);
        if (!folderFiles[folderId]) {
          console.log(`🟢 [ToggleFolder] Fetching folder contents for folder ${folderId}`);
          fetchFolderContents(folderId);
        }
      }
      return newExpanded;
    });
  };

  const processNodes = async (nodes: TreeNode[], initialContext: string) => {
    console.log(`🚀 [ProcessNodes] Start processing nodes with initial context:\n${initialContext}`);
    let currentContext = initialContext;
    const results = [];

    for (const node of nodes) {
      const prompt = node.prompt || "No prompt provided";
      console.log(`👉 [ProcessNodes] Processing node with prompt: ${prompt}`);
      const collectionContent =
        node.collection != null && node.collection > 0
          ? fetchCollectionContent(node.collection)
          : '';
      const combinedPrompt = `Context:\n${currentContext}\n ${collectionContent} \n\nUser Input:\n${prompt}`;
      let result = "";
      try {
        const response = await fetch("/api/gemini", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", text: combinedPrompt }],
            model: selectedModel }) });
        if (response.ok) {
          const data = await response.json();
          result = (data?.response ?? '').trim();
        } else {
          result = "Error: Gemini API returned an error.";
        }
      } catch {
        result = "Error: Unable to reach Gemini API.";
      }
      console.log(`✅ [ProcessNodes] Node result: ${result}`);
      node.result = result;

      if (node.keepMaster) {
        currentContext = currentContext + "\n" + result;
      } else {
        currentContext = result;
      }

      results.push({
        id: node.id,
        prompt: node.prompt,
        result: result,
        collection: node.collection ?? 0
      });
    }

    return results;
  };

  const handleRunAnalysis = async (file: FileItem) => {
    console.log(`🚀 [HandleRunAnalysis] Running analysis on file: ${file.name}`);
    if (analysisRunning) {
      console.log("❌ [HandleRunAnalysis] Analysis already running. Aborting new run.");
      return;
    }
    setAnalysisRunning(true);
    if (!projectFolder?.projectId) {
      console.log("❌ [HandleRunAnalysis] No projectFolder.projectId available.");
      setAnalysisRunning(false);
      return;
    }
    let content = fileContents[file.id];
    if (!content) {
      console.log(`🟢 [HandleRunAnalysis] Fetching content for file: ${file.id}`);
      content = await fetchFileContent(projectFolder.projectId, file.id);
      setFileContents((prev) => ({ ...prev, [file.id]: content }));
    }
    try {
      const parsedData = JSON.parse(content);
      console.log(`✅ [HandleRunAnalysis] Parsed JSON content for file: ${file.name}`);
      if (!Array.isArray(parsedData.layers)) {
        alert("File does not contain a valid steps array.");
        return;
      }
      const results = await processNodes(parsedData.layers, masterStringContext);
      setProcessedTree({ id: "root", prompt: "Processed Steps", children: results });
    } catch {
      console.error("❌ [HandleRunAnalysis] Failed to process file. Ensure it contains valid JSON.");
      alert("Failed to process file. Ensure it contains valid JSON.");
    } finally {
      setAnalysisRunning(false);
      console.log("🚀 [HandleRunAnalysis] Analysis run completed.");
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      alert("Copied to clipboard!");
    }).catch((err) => {
      console.error("Failed to copy: ", err);
    });
  };

  const downloadAsText = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const renderTree = (node: TreeNode): JSX.Element => (
    <div key={node.id} className="node-wrapper">
      <div className="node-summary">
        <strong>{node.prompt && node.prompt !== "Processed Steps" ? `Step: ${node.prompt}` : ""}</strong>
        {node.result && (
          <div className="summary-actions">
            <button
              className="project-button"
              onClick={(e) => {
                e.stopPropagation();
                if (node.result) {
                  copyToClipboard(node.result);
                } else {
                  console.warn("No result to copy for node:", node.id);
                }
              }}
            >
              Copy
            </button>
            <button
              className="project-button"
              onClick={(e) => {
                e.stopPropagation();
                if (node.result) {
                  downloadAsText(node.result, node.id)
                } else {
                  console.warn("No result to download for node:", node.id);
                }
              }
              }
            >
              Download
            </button>

          </div>
        )}
      </div>
      {node.result && (
        <div className="chain-result">
          <strong>→ Result:</strong>
          <MathJaxContext {...mathConfig}>
            <ReactMarkdown>{node.result}</ReactMarkdown>
          </MathJaxContext>
        </div>
      )}
      {node.children && node.children.length > 0 && (
        <div>{node.children.map((child) => renderTree(child))}</div>
      )}
    </div>
  );

  const mathConfig = {
    config: {
      loader: { load: ["[tex]/html"] },
      tex: {
        inlineMath: [["$", "$"]],
        displayMath: [["$$", "$$"]],
        packages: { "[+]": ["html"] } } },
    src: "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js",
    onError: (error: Error) => {
      console.error('❌ MathJax failed to load from jsDelivr CDN:', error);
      console.log('🔄 Consider using fallback CDN or self-hosting MathJax');
    }
  };

  return (
    <div className="container">
      <div className="column column-left">
        <div className="icon-container">
          <div className="refresh-icon" onClick={handleRefreshExtractItems} title="Refresh Extract Items">
            <FaSyncAlt />
          </div>
        </div>
        {extractItems.length > 0 ? (
          extractItems.map((item) =>
            item.mimeType === "application/vnd.google-apps.folder" ? (
              <div key={item.id} className="folder-container">
                <div className="folder-header" onClick={() => toggleFolder(item.id)}>
                  {expandedFolders.has(item.id) ? <FaChevronUp /> : <FaChevronDown />} &nbsp;
                  <span>{item.name}</span>
                </div>
                {expandedFolders.has(item.id) && (
                  <div className="folder-content">
                    <button className="refresh-button" onClick={() => fetchFolderContents(item.id)} disabled={!projectFolder?.projectId || analysisRunning}>
                      Sync Files
                    </button>
                    {folderFiles[item.id] && folderFiles[item.id].length > 0 && (
                      <div>
                        <h5>Files in {item.name}:</h5>
                        {folderFiles[item.id].map((file) => (
                          <div key={file.id} className="file-container">
                            <div>
                              <strong>{file.name}-------</strong>
                            </div>
                            <div>
                              <button onClick={() => toggleFileContent(file.id)}>
                                {expandedFileContents.has(file.id) ? "Hide File Content" : "Show File Content----"}
                              </button>
                            </div>
                            {expandedFileContents.has(file.id) && (
                              <div>
                                <pre className="file-content">
                                  {fileContents[file.id] || "Loading file content..."}
                                </pre>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div key={item.id} className="file-container">
                <div>
                  {
                    item.name.replace(/(?:[\W_]+)?jso(?:n)?(?:[\W_]+)?$/i, '').length > 20
                      ? item.name.replace(/(?:[\W_]+)?jso(?:n)?(?:[\W_]+)?$/i, '').slice(0, 20) + '...'
                      : item.name.replace(/(?:[\W_]+)?jso(?:n)?(?:[\W_]+)?$/i, '')
                  }
                </div>
                <div>
                  <button className="refresh-button" onClick={() => toggleFileContent(item.id)}>
                    {expandedFileContents.has(item.id) ? "Hide File Content" : "Show File Content"}
                  </button>
                </div>
                {expandedFileContents.has(item.id) && (
                  <div>
                    <pre className="file-content">
                      {fileContents[item.id] || "Loading file content..."}
                    </pre>
                  </div>
                )}
                <div style={{ margin: '0.5rem 0' }}>
                  <label>Model:</label>
                  <select
                    className="detail-select"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                  >
                    {models.map((model) => (
                      <option key={model.value} value={model.value}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="page-button" onClick={() => handleRunAnalysis(item)} disabled={analysisRunning}>
                  {analysisRunning ? "Running..." : "Run Agent"}
                </button>

              </div>
            )
          )
        ) : (
          <p>No Analysis found.</p>
        )}
      </div>
      <div className="column column-right">
        {analysisRunning ? (
          <div className="full-row-loading-bar"></div>
        ) : (
          <>
            {processedTree ? (
              renderTree(processedTree)
            ) : (
              <p>Click "Run Agent" or "Run Chain Process" to process JSON.</p>
            )}
          </>
        )}
      </div>

      <style jsx>{`
        .container {
          display: flex;
          background-color: #fff;
          color: #333;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          min-height: 100vh;
          padding: 1rem;
        }
        .column-left {
          width: 20%;
          padding: 1rem;
          border-right: 1px solid #ccc;
        }
        .column-right {
          width: 80%;
          padding: 1rem;
          overflow-y: auto;
          height: calc(100vh - 2rem);
        }
        .icon-container {
          display: flex;
          gap: 0;
          align-items: center;
        }
        .refresh-icon {
          cursor: pointer;
        }
        .folder-container {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 0.75rem;
          padding: 1.25rem;
          margin-bottom: 1rem;
          transition: all 0.2s ease;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        }
        .folder-container:hover {
          border-color: #d1d5db;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
          transform: translateY(-1px);
        }
        .folder-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 1rem;
          cursor: pointer;
          font-weight: 600;
          font-size: 1rem;
          color: #1e293b;
          transition: color 0.2s ease;
        }
        .folder-header:hover {
          color: #3b82f6;
        }
        .folder-content {
          margin-left: 0;
          margin-top: 1rem;
        }
        .refresh-button {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0.625rem 1rem;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          background: #ffffff;
          color: #6b7280;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 500;
          transition: all 0.2s ease;
          margin: 0.5rem 0;
        }
        .refresh-button:hover {
          background: #f8fafc;
          border-color: #d1d5db;
          color: #3b82f6;
        }
        .refresh-button:active {
          transform: translateY(1px);
        }
        .page-button {
          width: 100%;
          padding: 0.75rem;
          background: #0F084F;
          color: #ffffff;
          border: none;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          margin-top: 0.5rem;
        }
        .page-button:hover {
          background: #12074A;
        }
        .page-button:active {
          transform: translateY(1px);
        }
        .page-button:disabled {
          background: #9ca3af;
          cursor: not-allowed;
          transform: none;
        }
        .file-container {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 0.75rem;
          padding: 1.25rem;
          margin-bottom: 1rem;
          transition: all 0.2s ease;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          word-wrap: break-word;
          overflow-wrap: break-word;
          white-space: normal;
        }
        .file-container:hover {
          border-color: #d1d5db;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
          transform: translateY(-1px);
        }
        .file-content {
          background-color: #f5f5f5;
          padding: 0.5rem;
          white-space: pre-wrap;
          overflow: auto;
          border-radius: 4px;
          width: 95%;
          display: block;
          max-height: 200px;
        }
        .node-wrapper {
          // border: 0px solid #ccc;
          border-radius: 4px;
          margin-bottom: 1rem;
          overflow: hidden;
          background-color: #fff;
        }
        .node-summary {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.5rem;
          cursor: pointer;
          background-color: #F3F6FC;
        }
        .chain-result {
          margin-top: 0.5rem;
          padding: 0.5rem;
          background-color: #fff;
          border: 0px solid #ccc;
          border-radius: 4px;
          font-size: 1.2rem;
        }
        .full-row-loading-bar {
          width: 50%;
          height: 4px;
          background-color: #0D0221;
          margin: 0 auto;
          animation: smoothWave 3s ease-in-out infinite;
        }
        @keyframes smoothWave {
          0% {
            transform: translateX(-25%) skewX(-5deg);
          }
          50% {
            transform: translateX(25%) skewX(5deg);
          }
          100% {
            transform: translateX(-25%) skewX(-5deg);
          }
        }
      `}</style>
    </div>
  );
}
