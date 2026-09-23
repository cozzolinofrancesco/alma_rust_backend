
import type { XYPosition } from 'reactflow';

export type AgentNodeKind = 'step' | 'section';

export interface AgentNodeData {
  kind: AgentNodeKind;
  layerId: string;
  title: string;
  notes?: string;
  indexLabel: string;
  label?: string;
  headerLayerId?: string;
  headerTitle?: string;
  childCount?: number;
  tag?: string;
  hasOutput: boolean;
  isEdited: boolean;
  corpusId?: string;
  onClick?: (id: string) => void;
  direction?: 'LR' | 'TB';
}

export interface CorpusConsumer {
  nodeId: string;
  layerId: string;
  stepName: string;
  documentSelections: string[];
}

export interface CorpusNodeData {
  corpusId: string;
  name: string;
  consumers: CorpusConsumer[];
  onInspect?: (corpusId: string) => void;
}

export interface AgentNodeSerialised {
  id: string;
  type: 'c272Step' | 'c272Section';
  position: XYPosition;
  data: Omit<AgentNodeData, 'onClick'>;
}

export interface AgentEdgeSerialised {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface AgentNodesGraphV1 {
  version: 1;
  agentId: string;
  agentName: string;
  updatedAt: string;
  nodes: AgentNodeSerialised[];
  edges: AgentEdgeSerialised[];
}
