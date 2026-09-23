import { executionJson, readExecutionRequest, withExecutionAuth } from '@/app/lib/agentExecution/http.server';
import { executePortableStep } from '@/app/lib/agentExecution/step.server';
import { AgentExecutionError } from '@/app/lib/agentExecution/errors';
import { compilePortableReport, preparePortableSource } from '@/app/lib/reportCreation/api.server';
import { advancePortableRun, executeSavedStep, planPortableRun } from '@/app/lib/agentExecution/runner.server';
import { assemblePortableDocument, exportPortableDocument } from '@/app/lib/agentExecution/documents.server';
import { portableCapabilities, POST_OPERATIONS } from '@/app/lib/agentExecution/capabilities.server';

export const runtime = 'nodejs';
export const maxDuration = 300;

type RouteContext = { params: Promise<{ segments?: string[] }> };

export async function POST(request: Request, route: RouteContext) {
  return withExecutionAuth(request, async context => {
    const operation = (await route.params).segments?.join('/');
    if (!POST_OPERATIONS.some(path => path === operation)) return executionJson({ error: { code: 'NOT_FOUND', message: 'Unknown portable API operation.' } }, 404);
    const { raw, files } = await readExecutionRequest(request, context.signal);
    if (operation === 'documents/assemble' || operation?.startsWith('exports/')) {
      if (files.size) throw new AgentExecutionError('UNEXPECTED_FILE', 'Document operations accept JSON and embedded image data, not file uploads.');
      if (operation === 'documents/assemble') return executionJson(assemblePortableDocument(raw));
      return exportPortableDocument(raw, operation.slice('exports/'.length), context.signal);
    }
    if (operation === 'runs/plan') {
      if (files.size) throw new AgentExecutionError('UNEXPECTED_FILE', 'Planning accepts source manifests, not file bytes.');
      return executionJson(planPortableRun(raw));
    }
    if (operation === 'runs/advance') {
      const result = await advancePortableRun(raw, files, context);
      return executionJson(result.body, result.status);
    }
    if (operation === '272/compile') {
      if (files.size) throw new AgentExecutionError('UNEXPECTED_FILE', 'Compilation accepts source manifests, not file bytes.');
      return executionJson(await compilePortableReport(raw, context));
    }
    if (operation === '272/prepare-source') return executionJson(await preparePortableSource(raw, files, context));
    if (raw && typeof raw === 'object' && 'bundle' in raw) {
      const result = await executeSavedStep(raw, files, context);
      return executionJson(result.body, result.status);
    }
    return executionJson(await executePortableStep(raw, files, context));
  });
}

export async function GET(request: Request, route: RouteContext) {
  return withExecutionAuth(request, async () => {
    if ((await route.params).segments?.join('/') !== 'capabilities') return executionJson({ error: { code: 'NOT_FOUND', message: 'Unknown portable API operation.' } }, 404);
    return executionJson(portableCapabilities());
  });
}