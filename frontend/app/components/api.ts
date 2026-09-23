import axios from "axios";

const API_BASE_URL = "http://127.0.0.1:9393";

export interface Project {
    id: string;
    name: string;
}

export interface FileItem {
    id: string;
    name: string;
    mimeType: string;
}

export const createProject = async (token: string, projectName: string) => {
    return axios.post(`${API_BASE_URL}/projects`, { project_name: projectName }, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const setupProjectStructure = async (token: string, projectId: string) => {
    return axios.post(`${API_BASE_URL}/projects/${projectId}/setup`, {}, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const uploadFile = async (token: string, projectId: string, folderName: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("metadata", JSON.stringify({ name: file.name }));
    return axios.post(`${API_BASE_URL}/projects/${projectId}/folders/${folderName}/files`, formData, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "multipart/form-data",
        }
    });
};

export const listProjects = async (token: string) => {
    return axios.get(`${API_BASE_URL}/projects`, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const getCollaborators = async (token: string, projectId: string) => {
    return axios.get(`${API_BASE_URL}/projects/${projectId}/collaborators`, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const listFiles = async (token: string, projectId: string, folderName: string) => {
    return axios.get(`${API_BASE_URL}/projects/${projectId}/${folderName}/files`, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const getFilesByFolderId = async (token: string, folderId: string) => {
    return axios.get(`${API_BASE_URL}/files/${folderId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const readSpecificFile = async (token: string, projectId: string, fileId: string) => {
    return axios.get(`${API_BASE_URL}/projects/${projectId}/files/${fileId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const addCollaborator = async (token: string, projectId: string, email: string, role: string) => {
    return axios.post(`${API_BASE_URL}/projects/${projectId}/collaborators`, {
        email,
        role
    }, {
        headers: { Authorization: `Bearer ${token}` }
    });
};

export const listFolderContents = async (token: string, folderId: string) => {
    return axios.get(`${API_BASE_URL}/list-folder`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { folder_id: folderId }
    });
};

export const createFolder = async (token: string, parentId: string, folderName: string) => {
  return axios.post(
    `${API_BASE_URL}/create-folder`,
    { parent_id: parentId, folder_name: folderName },
    { headers: { Authorization: `Bearer ${token}` } }
  );
};

export const createSubfolder = async (
  token: string,
  projectId: string,
  parentFolder: string,
  folderName: string
) => {
  return axios.post(
    `${API_BASE_URL}/projects/${projectId}/folder/${parentFolder}/subfolder/${folderName}`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
};