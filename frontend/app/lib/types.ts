
import { Session } from 'next-auth';

export interface AgentFile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type Layers = JsonValue[];

export interface ParsedAgentJson {
  name: string;
  description?: string;
  layers: Layers;
}

export interface AgentJsonWithMetadata extends ParsedAgentJson {
  metadata?: {
    createdBy?: string;
    createdAt?: string;
    updatedBy?: string;
    updatedAt?: string;
  };
}

export interface SavedAgentsListProps {
  projectFolder: string | null;
  token: string | null;
  session: Session | null;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  onAgentLoad: (data: { layers: Layers; name: string; fileId: string }) => void;
}

export interface BibliographyItem {
  name: string;
  path: string;
  type?: 'file' | 'url' | 'reference' | 'corpus';
  description?: string;
  source?: string;
}

export interface Project {
  id: string;
  name: string;
  ownerName?: string;
  shared: boolean;
  modifiedTime?: string;
  size?: number | string;
}
