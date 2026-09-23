'use client';

import { useEffect, useState } from 'react';

interface FileItem {
  id: string;
  name: string;
  mimeType: string;
}

interface ExtractEntry {
  folder_id: string;
  folder_name: string;
  files: FileItem[];
}

interface ExtractsListProps {
  projectId: string;
  workflowId: string;
}

export default function ExtractsList({
  projectId,
  workflowId,
}: ExtractsListProps) {
  const [extracts, setExtracts] = useState<ExtractEntry[]>([]);

  useEffect(() => {
    const fetchExtracts = async () => {
      if (!projectId) {
        console.warn("No projectId available");
        return;
      }
      try {
        const response = await fetch(
          `http://127.0.0.1:9393/list_extracts?project_id=${projectId}&workflow_id=${workflowId}`,
          { mode: "cors" }
        );
        if (response.ok) {
          const data = await response.json();
          console.log("Fetched extracts:", data);
          setExtracts(data.extracts || []);
        } else {
          const errorData = await response.json();
          alert(`Error fetching extracts: ${errorData.error}`);
        }
      } catch (error) {
        console.error("Error fetching extracts:", error);
      }
    };

    fetchExtracts();
  }, [projectId, workflowId]);

  return (
    <div>
      {extracts.length > 0 ? (
        extracts.map((entry) => (
          <div key={entry.folder_id}>
            <h4>{entry.folder_name}</h4>
            {entry.files.map((file) => (
              <div key={file.id}>{file.name}</div>
            ))}
          </div>
        ))
      ) : (
        <p>No extracts available.</p>
      )}
    </div>
  );
}
