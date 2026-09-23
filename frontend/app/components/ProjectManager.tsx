'use client';

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import {
  addCollaborator,
  getCollaborators,
  setupProjectStructure,
  uploadFile,
  createSubfolder,
  listFolderContents,
} from "./api";
import { useProjectState } from "./ProjectStateContext";
import { MAX_PROJECT_NAME_LENGTH } from '../lib/project-constants';

interface Project {
  id: string;
  name: string;
}

interface Collaborator {
  email: string;
  role: string;
}

interface ApiCollaborator {
  emailAddress: string;
  role: string;
}


const containerStyle: React.CSSProperties = {
  background: "#F8F9FA",
  padding: "20px",
  fontFamily: "Arial, sans-serif",
};

const headerStyle: React.CSSProperties = {
  backgroundColor: "#d3d3d3",
  color: "#000",
  fontSize: "1rem",
  fontWeight: "bold",
  padding: "15px",
  borderRadius: "4px",
  margin: "20px auto",
  textAlign: "center",
  width: "50%",
};

const buttonStyle: React.CSSProperties = {
  backgroundColor: "rgb(204, 229, 254)",
  color: "rgb(0, 102, 204)",
  border: "none",
  borderRadius: "8px",
  padding: "10px 20px",
  margin: "8px 0 8px 10px",
  cursor: "pointer",
  fontWeight: "bold",
};

const disabledButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  cursor: "not-allowed",
  opacity: 0.6,
};

const inputStyle: React.CSSProperties = {
  width: "30%",
  padding: "8px",
  margin: "8px 0",
  borderRadius: "4px",
  border: "1px solid #ccc",
};

function showError(error: unknown, defaultMsg: string) {
  const message = error instanceof Error ? error.message : defaultMsg;
  alert(message);
}

function ProjectList({
  projects,
  onSelectProject,
  onListAll,
}: {
  projects: Project[];
  onSelectProject: (project: Project) => void;
  onListAll: () => void;
}) {
  return (
    <section style={{ marginLeft: "10px" }}>
      <h3 style={{ color: "#000" }}>Existing Projects</h3>
      <ul>
        {projects.map((proj) => (
          <li key={proj.id} style={{ marginBottom: "8px" }}>
            <button onClick={() => onSelectProject(proj)} style={buttonStyle}>
              {proj.name} (ID: {proj.id})
            </button>
          </li>
        ))}
      </ul>
      <button onClick={onListAll} style={buttonStyle}>
        List All Projects (ID & Name)
      </button>
    </section>
  );
}

function ProjectCreation({
  projectName,
  setProjectName,
  collaboratorEmail,
  setCollaboratorEmail,
  collaboratorRole,
  setCollaboratorRole,
  onCreateProject,
  onAddCollaborator,
  disabled,
}: {
  projectName: string;
  setProjectName: (value: string) => void;
  collaboratorEmail: string;
  setCollaboratorEmail: (value: string) => void;
  collaboratorRole: string;
  setCollaboratorRole: (value: string) => void;
  onCreateProject: () => void;
  onAddCollaborator: () => void;
  disabled: boolean;
}) {
  return (
    <section style={{ marginTop: "20px" }}>
      <h3 style={{ color: "#000" }}>Create a New Project</h3>
      <div>
        <label htmlFor="projectName">Project Name:</label>
        <input
          id="projectName"
          type="text"
          placeholder={`Project Name (max ${MAX_PROJECT_NAME_LENGTH} chars)`}
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          maxLength={MAX_PROJECT_NAME_LENGTH}
          style={inputStyle}
        />
        <button onClick={onCreateProject} style={buttonStyle}>
          Create Project
        </button>
      </div>
      <article style={{ marginTop: "10px" }}>
        <h4 style={{ color: "#000" }}>Add Collaborator to New Project</h4>
        <div>
          <label htmlFor="collabEmail">Email:</label>
          <input
            id="collabEmail"
            type="email"
            placeholder="Collaborator Email"
            value={collaboratorEmail}
            onChange={(e) => setCollaboratorEmail(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="collabRole">Role:</label>
          <select
            id="collabRole"
            value={collaboratorRole}
            onChange={(e) => setCollaboratorRole(e.target.value)}
            style={inputStyle}
          >
            <option value="reader">Reader</option>
            <option value="writer">Writer</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <button
          onClick={onAddCollaborator}
          disabled={disabled}
          style={disabled ? disabledButtonStyle : buttonStyle}
        >
          Add to Selected Project
        </button>
      </article>
    </section>
  );
}

export default function ProjectManager() {
  const { data: session } = useSession();
  const { token: globalToken, projectFolder, setProjectFolder } = useProjectState();
  const token = session?.accessToken || globalToken || '';

  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [folderName, setFolderName] = useState("Workflows");
  const [collaboratorEmail, setCollaboratorEmail] = useState("");
  const [collaboratorRole, setCollaboratorRole] = useState("reader");
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [parentFolderId, setParentFolderId] = useState("");
  const [subfolderName, setSubfolderName] = useState("");
  const [folderList, setFolderList] = useState<{ id: string; name: string }[]>([]);

  const selectedProjectData = projects.find((proj) => proj.id === selectedProject);
  const selectedProjectName = selectedProjectData ? selectedProjectData.name : "";

  useEffect(() => {
    async function fetchProjects() {
      try {
        const res = await fetch('/api/list-projects');
        if (!res.ok) {
          throw new Error(`Error: ${res.statusText}`);
        }
        const data = await res.json();
        setProjects(data.projects || []);
      } catch (err: unknown) {
        console.error("Error fetching projects:", err);
        setProjects([]);
      }
    }
    fetchProjects();
  }, []);

  useEffect(() => {
    if (selectedProject) {
      const selected = projects.find((proj) => proj.id === selectedProject);
      setProjectFolder({
        projectId: selectedProject,
        folderName: selected ? selected.name : "Unknown",
        files: [],
      });
      console.log(`Selected project: ${selectedProjectName} (ID: ${selectedProject})`);
    }
  }, [selectedProject, projects, setProjectFolder, selectedProjectName]);

  const handleCreateProject = async () => {
    if (!token) {
      alert("Not authenticated!");
      return;
    }
    try {
      const projectData = {
        project_name: projectName,
      };
  
      const response = await fetch('/api/create-project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(projectData),
      });
  
      if (response.ok) {
        const data = await response.json();
        alert(`Project created: ${data.project_name}`);
      } else {
        const errorData = await response.json();
        alert(`Error creating project: ${errorData.error}`);
      }
    } catch (error) {
      console.error("Error creating project:", error);
      alert("Unexpected error creating project.");
    }
  };

  const handleSetupStructure = async () => {
    if (!projectFolder || !token) {
      alert("Select a project and ensure you are logged in.");
      return;
    }
    try {
      await setupProjectStructure(token, projectFolder.projectId);
      alert("Project structure created successfully!");
    } catch (error) {
      showError(error, "Unexpected error setting up structure.");
    }
  };

  const handleUploadFile = async () => {
    if (!projectFolder || !file || !token) {
      alert("Select a project, choose a file, and ensure you are logged in.");
      return;
    }
    try {
      await uploadFile(token, projectFolder.projectId, folderName, file);
      alert(`File uploaded to ${folderName} successfully!`);
    } catch (error) {
      showError(error, "Unexpected error uploading file.");
    }
  };

  const fetchCollaborators = async () => {
    if (!token || !projectFolder) return alert("Select a project first!");
    try {
      const response = await getCollaborators(token, projectFolder.projectId);
      const apiCollaborators: ApiCollaborator[] = response.data.collaborators;
      const formatted: Collaborator[] = apiCollaborators.map((collab) => ({
        email: collab.emailAddress,
        role: collab.role,
      }));
      setCollaborators(formatted);
      console.log("Collaborators fetched:", formatted);
    } catch (error) {
      showError(error, "Unexpected error fetching collaborators.");
    }
  };

  const handleAddCollaboratorToProject = async () => {
    if (!token || !projectFolder || !collaboratorEmail) {
      alert("Select a project and provide an email.");
      return;
    }
    try {
      await addCollaborator(token, projectFolder.projectId, collaboratorEmail, collaboratorRole);
      alert(`Collaborator ${collaboratorEmail} added as ${collaboratorRole}!`);
      fetchCollaborators();
    } catch (error) {
      showError(error, "Unexpected error adding collaborator.");
    }
  };

  const handleCreateSubfolder = async () => {
    if (!token || !projectFolder) {
      alert("Select a project and ensure you are logged in.");
      return;
    }
    if (!parentFolderId || !subfolderName) {
      alert("Provide both the parent folder ID and subfolder name.");
      return;
    }
    try {
      await createSubfolder(token, projectFolder.projectId, parentFolderId, subfolderName);
      alert(`Subfolder '${subfolderName}' created successfully!`);
    } catch (error) {
      showError(error, "Unexpected error creating subfolder.");
    }
  };

  const handleListAllProjects = () => {
    if (projects.length === 0) {
      alert("No projects found.");
      return;
    }
    const list = projects.map((p) => `ID: ${p.id}, Name: ${p.name}`).join("\n");
    alert(`Projects:\n${list}`);
  };

  const fetchProjectFolders = async () => {
    if (!token || !projectFolder) {
      alert("Select a project first!");
      return;
    }
    try {
      const response = await listFolderContents(token, projectFolder.projectId);
      setFolderList(response.data.folders || response.data);
    } catch (error) {
      showError(error, "Unexpected error fetching folders.");
    }
  };

  useEffect(() => {
    if (projectFolder) {
      fetchProjectFolders();
    }
  }, [projectFolder, token]);

  return (
    <>
      {!token ? (
        <p>Add the Refresh Token or Login again</p>
      ) : (
        <div style={containerStyle}>
          <header style={headerStyle}>
            {projectFolder 
              ? `Selected Project: ${projectFolder.folderName} (ID: ${projectFolder.projectId})`
              : "No Project Selected"}
          </header>

          <ProjectList
            projects={projects}
            onSelectProject={(proj) => {
              setSelectedProject(proj.id);
              setProjectFolder({ projectId: proj.id, folderName: proj.name, files: [] });
              console.log("Project selected:", proj);
            }}
            onListAll={handleListAllProjects}
          />

          <ProjectCreation
            projectName={projectName}
            setProjectName={setProjectName}
            collaboratorEmail={collaboratorEmail}
            setCollaboratorEmail={setCollaboratorEmail}
            collaboratorRole={collaboratorRole}
            setCollaboratorRole={setCollaboratorRole}
            onCreateProject={handleCreateProject}
            onAddCollaborator={handleAddCollaboratorToProject}
            disabled={!projectFolder}
          />

          <section style={{ marginTop: "20px", marginLeft: "10px" }}>
            <h3 style={{ color: "#000" }}>Setup Project Structure</h3>
            <button
              onClick={handleSetupStructure}
              disabled={!projectFolder}
              style={projectFolder ? buttonStyle : disabledButtonStyle}
            >
              Setup Folder Structure
            </button>
          </section>

          <section style={{ marginTop: "20px", marginLeft: "10px" }}>
            <h3 style={{ color: "#000" }}>Upload a File</h3>
            <div>
              <label htmlFor="folderSelect">Select Folder:</label>
              <select
                id="folderSelect"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                style={inputStyle}
              >
                <option value="Workflows">Workflows</option>
                <option value="Chats">Chats</option>
                <option value="Images">Images</option>
                <option value="PDFs">PDFs</option>
                <option value="AF">AF</option>
              </select>
            </div>
            <div>
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                style={{ margin: "8px 0", marginLeft: "10px" }}
              />
              <button
                onClick={handleUploadFile}
                disabled={!projectFolder || !file}
                style={projectFolder && file ? buttonStyle : disabledButtonStyle}
              >
                Upload File
              </button>
            </div>
          </section>

          <section style={{ marginTop: "20px", marginLeft: "10px" }}>
            <h3 style={{ color: "#000" }}>Create a Subfolder</h3>
            <div>
              <input
                type="text"
                placeholder="Parent Folder ID"
                value={parentFolderId}
                onChange={(e) => setParentFolderId(e.target.value)}
                style={inputStyle}
              />
              <input
                type="text"
                placeholder="Subfolder Name"
                value={subfolderName}
                onChange={(e) => setSubfolderName(e.target.value)}
                style={inputStyle}
              />
              <button
                onClick={handleCreateSubfolder}
                disabled={!projectFolder}
                style={projectFolder ? buttonStyle : disabledButtonStyle}
              >
                Create Subfolder
              </button>
            </div>
          </section>

          <section style={{ marginTop: "20px", marginLeft: "10px" }}>
            <h3 style={{ color: "#000" }}>Project Collaborators</h3>
            <button
              onClick={fetchCollaborators}
              disabled={!projectFolder}
              style={projectFolder ? buttonStyle : disabledButtonStyle}
            >
              Get Collaborators
            </button>
            <ul style={{ marginLeft: "20px" }}>
              {collaborators.length > 0 ? (
                collaborators.map((collab, index) => (
                  <li key={index} style={{ margin: "4px 0" }}>
                    {collab.email} - {collab.role}
                  </li>
                ))
              ) : (
                <p>No collaborators found.</p>
              )}
            </ul>
          </section>

          <section style={{ marginTop: "20px", marginLeft: "10px" }}>
            <h3 style={{ color: "#000" }}>Project Folders</h3>
            <button
              onClick={fetchProjectFolders}
              disabled={!projectFolder}
              style={projectFolder ? buttonStyle : disabledButtonStyle}
            >
              Refresh Folders
            </button>
            <ul style={{ marginLeft: "20px" }}>
              {folderList.length > 0 ? (
                folderList.map((folder) => (
                  <li key={folder.id} style={{ margin: "4px 0" }}>
                    {folder.name} ({folder.id})
                  </li>
                ))
              ) : (
                <p>No folders found.</p>
              )}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
