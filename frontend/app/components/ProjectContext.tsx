import React, { createContext, useContext, useState, ReactNode } from 'react';

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
}

export type ProjectFolder = {
  projectId: string;
  folderName: string;
  files: FileMetadata[];
} | null;

type ProjectContextType = {
  projectFolder: ProjectFolder;
  setProjectFolder: React.Dispatch<React.SetStateAction<ProjectFolder>>;
};

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

type ProjectProviderProps = {
  children: ReactNode;
};

export function ProjectProvider({ children }: ProjectProviderProps) {
  const [projectFolder, setProjectFolder] = useState<ProjectFolder>(null);

  return (
    <ProjectContext.Provider value={{ projectFolder, setProjectFolder }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextType {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
}
