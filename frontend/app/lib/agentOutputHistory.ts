export interface AgentOutputVersion {
  version: number;
  timestamp: string;
  result: string;
  imageUrls: string[];
}

export interface LayerWithOutputHistory {
  result?: string;
  output?: string;
  imageUrls?: string[];
  outputHistory?: AgentOutputVersion[];
  modified?: string;
  created?: string;
}

export function applyAgentLayerPatch<Layer extends LayerWithOutputHistory>(
  layer: Layer,
  patch: Partial<Layer>,
  timestamp = new Date().toISOString(),
): Layer {
  const updated = { ...layer, ...patch };
  if (typeof patch.result !== 'string' && !Array.isArray(patch.imageUrls)) return updated;

  const recorded = recordAgentOutput(layer, {
    result: patch.result ?? layer.result ?? layer.output ?? '',
    imageUrls: patch.imageUrls ?? (patch.result === undefined ? layer.imageUrls : []),
  }, timestamp);
  return {
    ...updated,
    result: recorded.result,
    imageUrls: recorded.imageUrls,
    outputHistory: recorded.outputHistory,
  };
}

export function recordAgentOutput<Layer extends LayerWithOutputHistory>(
  layer: Layer,
  output: { result: string; imageUrls?: string[] },
  timestamp = new Date().toISOString(),
): Layer & { result: string; imageUrls: string[]; outputHistory: AgentOutputVersion[] } {
  const history = (layer.outputHistory ?? []).map(version => ({
    ...version,
    imageUrls: [...version.imageUrls],
  }));
  const previousResult = layer.result ?? layer.output ?? '';
  if (history.length === 0 && (previousResult !== '' || layer.imageUrls?.length)) {
    history.push({
      version: 1,
      timestamp: layer.modified || layer.created || timestamp,
      result: previousResult,
      imageUrls: [...(layer.imageUrls ?? [])],
    });
  }

  const nextVersion = history.reduce((highest, version) => Math.max(highest, version.version), 0) + 1;
  const imageUrls = [...(output.imageUrls ?? [])];
  return {
    ...layer,
    result: output.result,
    imageUrls,
    outputHistory: [...history, {
      version: nextVersion,
      timestamp,
      result: output.result,
      imageUrls: [...imageUrls],
    }],
  };
}