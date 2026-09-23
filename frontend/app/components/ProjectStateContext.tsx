'use client';

import { ReactNode } from 'react';

export { useProjectState } from './CompatibilityHooks';

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface ProjectFolder {
  projectId: string;
  folderName: string;
  files: FileMetadata[];
}

export interface UserInfo {
  name: string;
  email: string;
  icon?: string;
}

export function ProjectStateProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
