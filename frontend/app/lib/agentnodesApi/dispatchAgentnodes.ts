import { NextRequest, NextResponse } from 'next/server';
import { getAgentnodesDrive } from './driveFromRequest';
import * as H from './handlers';

function methodNotAllowed(): NextResponse {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

export async function dispatchAgentnodes(
  request: NextRequest,
  projectId: string,
  segments: string[] | undefined
): Promise<Response> {
  const s = Array.isArray(segments) ? segments : [];
  const method = request.method;

  const ctx = await getAgentnodesDrive(request);
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { drive, email, accessToken, refreshToken } = ctx;

  if (s.length === 0) {
    return NextResponse.json(
      { error: 'Not found', hint: 'Try /agents, /runs/{id}, /recipes, /webhooks/subscriptions, …' },
      { status: 404 }
    );
  }

  const head = s[0];

  if (head === 'agents') {
    if (s.length === 1) {
      if (method === 'GET') return H.handleListAgents(drive, projectId);
      if (method === 'POST') return H.handleCreateAgent(drive, projectId, request);
      return methodNotAllowed();
    }
    const agentId = s[1];
    if (s.length === 2) {
      if (method === 'GET') return H.handleGetAgent(drive, agentId);
      if (method === 'PATCH') return H.handlePatchAgent(drive, agentId, request);
      if (method === 'PUT') return H.handlePutAgent(drive, agentId, request);
      if (method === 'DELETE') return H.handleDeleteAgent(drive, agentId);
      return methodNotAllowed();
    }
    const rest = s.slice(2);

    if (rest[0] === 'summary' && rest.length === 1 && method === 'GET') {
      return H.handleAgentSummary(drive, agentId);
    }
    if (rest[0] === 'versions' && rest.length === 1) {
      if (method === 'GET') return H.handleListVersions(drive, agentId);
      if (method === 'POST') return H.handlePostNewVersion(drive, agentId, request);
      return methodNotAllowed();
    }
    if (rest[0] === 'versions' && rest.length === 2 && method === 'GET') {
      return H.handleGetVersion(drive, agentId, rest[1]);
    }
    if (rest[0] === 'clone' && rest.length === 1 && method === 'POST') {
      return H.handleCloneAgent(drive, projectId, agentId, request);
    }
    if (rest[0] === 'voice-context' && rest.length === 1 && method === 'GET') {
      return H.handleVoiceContext(drive, projectId, agentId);
    }

    if (rest[0] === 'corpus-bindings' && rest.length === 1 && method === 'GET') {
      return H.handleCorpusBindings(drive, agentId);
    }
    if (rest[0] === 'corpus-bindings' && rest[1] === 'verify' && rest.length === 2 && method === 'POST') {
      return H.handleCorpusVerify();
    }

    if (rest[0] === 'layers' && rest.length === 1) {
      if (method === 'GET') return H.handleListLayers(drive, agentId);
      if (method === 'POST') return H.handlePostLayer(drive, agentId, request);
      return methodNotAllowed();
    }
    if (rest[0] === 'layers' && rest[1] === 'reorder' && rest.length === 2 && method === 'POST') {
      return H.handleReorderLayers(drive, agentId, request);
    }
    if (rest[0] === 'layers' && rest[1] === 'reorder') {
      return methodNotAllowed();
    }
    if (rest[0] === 'layers' && rest.length >= 2) {
      const layerId = rest[1];
      if (rest.length === 2) {
        if (method === 'GET') return H.handleGetLayer(drive, agentId, layerId);
        if (method === 'PATCH') return H.handlePatchLayer(drive, agentId, layerId, request);
        if (method === 'PUT') return H.handlePutLayer(drive, agentId, layerId, request);
        if (method === 'DELETE') return H.handleDeleteLayer(drive, agentId, layerId);
        return methodNotAllowed();
      }
      if (rest[2] === 'duplicate' && rest.length === 3 && method === 'POST') {
        return H.handleDuplicateLayer(drive, agentId, layerId);
      }
      if (rest[2] === 'tag' && rest.length === 3 && method === 'PATCH') {
        return H.handleLayerTag(drive, agentId, layerId, request);
      }
      if (rest[2] === 'corpus' && rest.length === 3) {
        if (method === 'PATCH') return H.handleLayerCorpusPatch(drive, agentId, layerId, request);
        if (method === 'DELETE') return H.handleLayerCorpusDelete(drive, agentId, layerId);
        return methodNotAllowed();
      }
      if (rest[2] === 'documents' && rest.length === 3 && method === 'PATCH') {
        return H.handleLayerDocuments(drive, agentId, layerId, request);
      }
      if (rest[2] === 'model' && rest.length === 3 && method === 'PATCH') {
        return H.handleLayerModel(drive, agentId, layerId, request);
      }
      if (rest[2] === 'validate' && rest.length === 3 && method === 'POST') {
        return H.handleLayerValidate();
      }
    }

    if (rest[0] === 'graph' && rest.length === 1) {
      return H.handleGraphDocument(drive, projectId, agentId, method, request);
    }
    if (rest[0] === 'graph' && rest[1] === 'validate' && rest.length === 2 && method === 'POST') {
      return H.handleGraphValidate(drive, projectId, agentId);
    }
    if (rest[0] === 'graph' && rest[1] === 'diff' && rest.length === 2 && method === 'POST') {
      return H.handleGraphDiff(drive, projectId, agentId, request);
    }
    if (rest[0] === 'graph' && rest[1] === 'import' && rest.length === 2 && method === 'POST') {
      return H.handleGraphImport(drive, projectId, agentId, request);
    }
    if (rest[0] === 'graph' && rest[1] === 'reset' && rest.length === 2 && method === 'POST') {
      return H.handleGraphReset(drive, projectId, agentId);
    }
    if (rest[0] === 'graph' && rest[1] === 'export' && rest.length === 2 && method === 'GET') {
      return H.handleGraphExport();
    }
    if (rest[0] === 'graph' && rest[1] === 'topology' && rest.length === 2 && method === 'GET') {
      return H.handleGraphTopology(drive, projectId, agentId);
    }
    if (rest[0] === 'graph' && rest[1] === 'preferences' && rest.length === 2) {
      return H.handleGraphPreferences(drive, projectId, agentId, method, request);
    }
    if (rest[0] === 'graph' && rest[1] === 'layout' && rest.length === 2 && method === 'POST') {
      return H.handleGraphLayout(drive, projectId, agentId, request, 'compact', 'both', true);
    }
    if (rest[0] === 'graph' && rest[1] === 'layout' && rest[2] === 'preview' && rest.length === 3 && method === 'POST') {
      return H.handleGraphLayout(drive, projectId, agentId, request, 'compact', 'both', false);
    }
    if (rest[0] === 'graph' && rest[1] === 'layout' && rest[2] === 'compact' && rest.length === 3 && method === 'POST') {
      return H.handleGraphLayout(drive, projectId, agentId, request, 'compact', 'both', true);
    }
    if (rest[0] === 'graph' && rest[1] === 'layout' && rest[2] === 'relax' && rest.length === 3 && method === 'POST') {
      return H.handleGraphLayout(drive, projectId, agentId, request, 'relax', 'both', true);
    }

    if (rest[0] === 'graph' && rest[1] === 'nodes' && rest.length === 2) {
      if (method === 'GET') return H.handleListGraphNodes(drive, projectId, agentId);
      if (method === 'POST') return H.handlePostGraphNode(drive, projectId, agentId, request);
      return methodNotAllowed();
    }
    if (rest[0] === 'graph' && rest[1] === 'nodes' && rest[2] === 'bulk-delete' && rest.length === 3 && method === 'POST') {
      return H.handleBulkDeleteNodes(drive, projectId, agentId, request);
    }
    if (rest[0] === 'graph' && rest[1] === 'nodes' && rest.length >= 3) {
      const nodeId = rest[2];
      if (rest.length === 3) {
        if (method === 'GET') return H.handleGetGraphNode(drive, projectId, agentId, nodeId);
        if (method === 'PATCH') return H.handlePatchGraphNode(drive, projectId, agentId, nodeId, request);
        if (method === 'DELETE') return H.handleDeleteGraphNode(drive, projectId, agentId, nodeId);
        return methodNotAllowed();
      }
      if (rest[3] === 'position' && rest.length === 4 && method === 'PATCH') {
        return H.handlePatchGraphNodePosition(drive, projectId, agentId, nodeId, request);
      }
      if (rest[3] === 'data' && rest.length === 4 && method === 'PATCH') {
        return H.handlePatchGraphNodeData(drive, projectId, agentId, nodeId, request);
      }
      if (rest[3] === 'tag' && rest.length === 4 && method === 'PATCH') {
        return H.handleGraphNodeTag(drive, projectId, agentId, nodeId, request);
      }
      if (rest[3] === 'corpus' && rest.length === 4) {
        if (method === 'PATCH') return H.handleGraphNodeCorpusPatch(drive, projectId, agentId, nodeId, request);
        if (method === 'DELETE') return H.handleGraphNodeCorpusDelete(drive, projectId, agentId, nodeId);
        return methodNotAllowed();
      }
      if (rest[3] === 'documents' && rest.length === 4 && method === 'PATCH') {
        return H.handleGraphNodeDocuments(drive, projectId, agentId, nodeId, request);
      }
      if (rest[3] === 'model' && rest.length === 4 && method === 'PATCH') {
        return H.handleGraphNodeModel(drive, projectId, agentId, nodeId, request);
      }
      if (rest[3] === 'duplicate' && rest.length === 4 && method === 'POST') {
        return H.handlePostGraphNodeDuplicate(drive, projectId, agentId, nodeId);
      }
    }

    if (rest[0] === 'graph' && rest[1] === 'edges' && rest.length === 2) {
      if (method === 'GET') return H.handleListEdges(drive, projectId, agentId);
      if (method === 'POST') return H.handlePostEdge(drive, projectId, agentId, request);
      return methodNotAllowed();
    }
    if (rest[0] === 'graph' && rest[1] === 'edges' && rest[2] === 'bulk' && rest.length === 3) {
      return H.handleBulkEdges(drive, projectId, agentId, method, request);
    }
    if (rest[0] === 'graph' && rest[1] === 'edges' && rest[2] === 'validate' && rest.length === 3 && method === 'POST') {
      return H.handleEdgesValidate(drive, projectId, agentId);
    }
    if (rest[0] === 'graph' && rest[1] === 'edges' && rest.length === 3) {
      const edgeId = rest[2];
      if (method === 'GET') return H.handleGetEdge(drive, projectId, agentId, edgeId);
      if (method === 'PATCH') return H.handlePatchEdge(drive, projectId, agentId, edgeId, request);
      if (method === 'DELETE') return H.handleDeleteEdge(drive, projectId, agentId, edgeId);
      return methodNotAllowed();
    }

    if (rest[0] === 'graph' && rest[1] === 'snapshots') {
      return H.handleSnapshots(drive, projectId, agentId, method, request, rest.slice(2));
    }
    if (rest[0] === 'graph' && rest[1] === 'recipes' && rest[2] && rest[3] === 'apply' && rest.length === 4 && method === 'POST') {
      return H.handleRecipeApply();
    }

    if (rest[0] === 'runs' && rest.length === 1) {
      if (method === 'GET') return H.handleRunsList(drive, projectId, agentId);
      if (method === 'POST') return H.handleRunsPost(drive, projectId, agentId);
      return methodNotAllowed();
    }
    if (rest[0] === 'runs' && rest[1] === 'preview' && rest.length === 2 && method === 'POST') {
      return H.handleRunPreview();
    }

    if (rest[0] === 'simulations' && rest.length === 1 && method === 'POST') {
      return H.handleSimulationsPost(drive, projectId, agentId);
    }

    if (rest[0] === 'exports' && rest.length === 1 && method === 'POST') {
      return H.handleExportsPost();
    }
    if (rest[0] === 'export-package' && rest.length === 1 && method === 'GET') {
      return H.handleExportPackage();
    }
    if (rest[0] === 'exports' && rest[1] === 'structured' && rest.length === 2 && method === 'POST') {
      return H.handleExportStructured();
    }

    if (rest[0] === 'reviews' && rest[1] === 'from-graph' && rest.length === 2 && method === 'POST') {
      return H.handleReviewFromGraph();
    }

    return NextResponse.json({ error: 'Not found', path: s.join('/') }, { status: 404 });
  }

  if (head === 'runs' && s.length === 2) {
    const runId = s[1];
    if (method === 'GET' || method === 'DELETE') return H.handleRunById(drive, projectId, runId, method);
    return methodNotAllowed();
  }
  if (head === 'runs' && s.length === 3 && s[1] && s[2] === 'cancel' && method === 'POST') {
    return H.handleRunCancel();
  }
  if (head === 'runs' && s.length === 3 && s[2] === 'steps' && method === 'GET') {
    return H.handleRunSteps();
  }
  if (head === 'runs' && s.length === 4 && s[2] === 'steps' && method === 'GET') {
    return H.handleRunStepDetail();
  }

  if (head === 'simulations' && s.length === 2) {
    return H.handleSimulationById(drive, projectId, s[1], method, request);
  }
  if (head === 'simulations' && s.length === 3 && s[2] === 'reset' && method === 'POST') {
    return H.handleSimulationReset(drive, projectId, s[1]);
  }

  if (head === 'recipes' && s.length === 1 && method === 'GET') {
    return H.handleRecipesList();
  }
  if (head === 'recipes' && s.length === 2 && method === 'GET') {
    return H.handleRecipeGet(s[1]);
  }

  if (head === 'corpora' && s.length === 1 && method === 'GET') {
    return H.handleCorporaRegistry();
  }

  if (head === 'corpus-links' && s.length === 1) {
    if (method === 'GET') return H.handleProjectCorpusLinksList(drive, projectId);
    if (method === 'POST') return H.handleProjectCorpusLinksAdd(drive, projectId, request, email);
    return methodNotAllowed();
  }
  if (head === 'corpus-links' && s[1] === 'scan' && s.length === 2 && method === 'POST') {
    return H.handleProjectCorpusLinksScan(drive, projectId, email, accessToken, refreshToken);
  }
  if (head === 'corpus-links' && s.length === 2 && method === 'DELETE') {
    return H.handleProjectCorpusLinksRemove(drive, projectId, decodeURIComponent(s[1]), email);
  }

  if (head === 'exports' && s.length === 2 && method === 'GET') {
    return H.handleExportGet(s[1]);
  }
  if (head === 'exports' && s.length === 2 && method === 'DELETE') {
    return H.handleExportDelete();
  }

  if (head === 'webhooks' && s[1] === 'subscriptions' && s.length === 2) {
    if (method === 'GET') return H.handleWebhooksList(drive, projectId);
    if (method === 'POST') return H.handleWebhooksPost(drive, projectId, request);
    return methodNotAllowed();
  }
  if (head === 'webhooks' && s[1] === 'subscriptions' && s.length === 3 && method === 'DELETE') {
    return H.handleWebhooksDelete(drive, projectId, s[2]);
  }
  if (head === 'webhooks' && s[1] === 'test' && s.length === 2 && method === 'POST') {
    return H.handleWebhooksTest();
  }

  if (head === 'simulate' && s.length === 1 && method === 'POST') {
    return H.handleServerSimulate();
  }
  if (head === 'simulate' && s[1] === 'presets' && s.length === 2 && method === 'GET') {
    return H.handleSimPresets();
  }

  return NextResponse.json({ error: 'Not found', path: s.join('/') }, { status: 404 });
}
