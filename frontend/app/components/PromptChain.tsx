"use client";
import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import styles from "../tool/tool.module.css";
import { useProjectState } from "./ProjectStateContext";

interface Project {
  id: string;
  name: string;
}

interface Layer {
  id: string;
  prompt: string;
  condition: string;
  result: string;
  "button-name": string;
  model: string;
  children: Layer[];
}

export default function PromptChain() {
  const { data: session } = useSession();
  const { token: globalToken } = useProjectState();
  const token = session?.accessToken || globalToken || "";
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [analysisName, setAnalysisName] = useState<string>("");
  const [layers, setLayers] = useState<Layer[]>([
    {
      id: "1",
      prompt: "",
      condition: "",
      result: "",
      "button-name": "",
      model: "",
      children: [],
    },
  ]);

  useEffect(() => {
    const fetchProjects = async () => {
      if (!token) {
        console.warn("No token available. Skipping fetchProjects call.");
        return;
      }
      try {
        const response = await fetch("/api/list-projects", {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (response.ok) {
          const data = await response.json();
          console.log("Fetched projects:", data);
          setProjects(data.projects || []);
        } else {
          const errorData = await response.json();
          console.log(`Error fetching projects: ${errorData.error}`);
        }
      } catch (error) {
        console.error("Error fetching projects:", error);
      }
    };
    fetchProjects();
  }, [token]);

  const saveToGoogleDrive = async (): Promise<void> => {
    if (!token) {
      alert("Please log in to save the JSON to Google Drive.");
      return;
    }
    if (!selectedProject) {
      alert("Please select a project.");
      return;
    }
    if (!analysisName) {
      alert("Please enter an analysis name.");
      return;
    }
    const data: string = JSON.stringify(layers, null, 2);
    const blob: Blob = new Blob([data], { type: "application/json" });
    const file: File = new File([blob], `${analysisName}.json`, {
      type: "application/json",
    });
    try {
      const url = `/api/projects/${selectedProject}/folders/AF/files`;
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (response.ok) {
        const result = await response.json();
        alert(`File uploaded successfully! File ID: ${result.file_id}`);
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || "Error uploading file");
      }
    } catch (error) {
      alert("Error uploading file to Google Drive.");
      console.error("Upload error:", error);
    }
  };

  const updateNodeInLayers = (
    layersArr: Layer[],
    targetId: string,
    updater: (node: Layer) => Layer
  ): Layer[] => {
    return layersArr.map((layer) => {
      if (layer.id === targetId) {
        return updater(layer);
      }
      return {
        ...layer,
        children: updateNodeInLayers(layer.children, targetId, updater),
      };
    });
  };

  const updateNodeText = (nodeId: string, key: keyof Layer, value: string) => {
    setLayers((prev) =>
      updateNodeInLayers(prev, nodeId, (node) => ({
        ...node,
        [key]: value,
      }))
    );
  };

  const addTopLevelNode = (): void => {
    setLayers((prev) => {
      const newId: string = (prev.length + 1).toString();
      const newLayer: Layer = {
        id: newId,
        prompt: "",
        condition: "",
        result: "",
        "button-name": "",
        model: "",
        children: [],
      };
      return [...prev, newLayer];
    });
  };

  const addChildNode = (parentId: string): void => {
    setLayers((prev) =>
      updateNodeInLayers(prev, parentId, (node) => {
        const newChildId: string = `${node.id}.${node.children.length + 1}`;
        const newChild: Layer = {
          id: newChildId,
          prompt: "",
          condition: "",
          result: "",
          "button-name": "",
          model: "",
          children: [],
        };
        return { ...node, children: [...node.children, newChild] };
      })
    );
  };

  const deleteNode = (nodeId: string): void => {
    setLayers((prev) => {
      const removeNode = (nodes: Layer[]): Layer[] =>
        nodes
          .filter((node) => node.id !== nodeId)
          .map((node) => ({
            ...node,
            children: removeNode(node.children),
          }));
      return removeNode(prev);
    });
  };

  const renderNode = (node: Layer, depth: number = 1): JSX.Element => {
    const pastelColors: string[] = [
      "#F7D9C4",
      "#C7E5D6",
      "#E4D7F1",
      "#FBE6A2",
      "#D4E8E2",
    ];
    const backgroundColor: string =
      pastelColors[depth % pastelColors.length];
    return (
      <div
        className={styles.node}
        key={node.id}
        style={{
          backgroundColor,
          borderRadius: "8px",
          padding: "10px",
          marginBottom: "10px",
          boxShadow: "0px 2px 5px rgba(0, 0, 0, 0.1)",
        }}
      >
        <div className={styles.nodeHeader}>
          <label className={styles.label}>Prompt #{node.id}</label>
          <button
            className={`${styles.button} ${styles.deleteBtn}`}
            style={{ backgroundColor: "#FF6666", color: "white" }}
            onClick={() => deleteNode(node.id)}
          >
            ✖
          </button>
        </div>
        <input
          type="text"
          placeholder="Node Name"
          value={node["button-name"]}
          onChange={(e) => updateNodeText(node.id, "button-name", e.target.value)}
          className={styles.inputField}
        />
        <textarea
          placeholder="Prompt"
          value={node.prompt}
          onChange={(e) => updateNodeText(node.id, "prompt", e.target.value)}
          className={styles.inputField}
        />
        <input
          type="text"
          placeholder="Condition"
          value={node.condition}
          onChange={(e) => updateNodeText(node.id, "condition", e.target.value)}
          className={styles.inputField}
        />
        <input
          type="text"
          placeholder="Result"
          value={node.result}
          onChange={(e) => updateNodeText(node.id, "result", e.target.value)}
          className={styles.inputField}
        />
        <label className={styles.label} htmlFor={`modelSelect-${node.id}`}>
          Model:
        </label>
        <select
          id={`modelSelect-${node.id}`}
          className={styles.selectBox}
          value={node.model}
          onChange={(e) => updateNodeText(node.id, "model", e.target.value)}
        >
          <option value="" disabled>
            Select a model
          </option>
          <option value="gemini">Gemini</option>
          <option value="openai">OpenAI</option>
        </select>
        <button
          className={`${styles.button} ${styles.smallAddBtn}`}
          onClick={() => addChildNode(node.id)}
        >
          + Add Child
        </button>
        <div className={styles.childrenWrapper}>
          {node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      </div>
    );
  };

  return (
    <div className={styles.toolContainer}>
      <h1 className={styles.title}>Analysis Builder</h1>
      <select
        id="projectSelect"
        className={styles.selectBox}
        value={selectedProject || ""}
        onChange={(e) => setSelectedProject(e.target.value)}
      >
        <option value="" disabled>
          Select a project
        </option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <button
        onClick={saveToGoogleDrive}
        className={`${styles.button} ${styles.exportBtn}`}
      >
        Save to Google Drive
      </button>
      <input
        id="analysisName"
        type="text"
        value={analysisName}
        onChange={(e) => setAnalysisName(e.target.value)}
        className={styles.analysisNameInput}
        placeholder="Enter analysis name"
      />
      <div>
        <button
          onClick={addTopLevelNode}
          className={`${styles.button} ${styles.exportBtn}`}
        >
          Add Step
        </button>
      </div>
      <div className={styles.rootWrapper}>
        {layers.map((layer) => renderNode(layer, 1))}
      </div>
    </div>
  );
}
