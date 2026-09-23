import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAgentnodesDrive } from './agentnodesApi/driveFromRequest';
import { ProjectSkillsStore, type SaveProjectSkill, type SkillUpload } from './projectSkills-gdrive';
import { ProjectSkillsError, ProjectSkillCreateSchema, ProjectSkillPatchSchema, SkillRefsSchema } from './projectSkills';

export type ProjectSkillsParams = { project_id: string; skillId?: string };

export async function withProjectSkills(
  request: NextRequest,
  params: Promise<ProjectSkillsParams>,
  handler: (store: ProjectSkillsStore, params: ProjectSkillsParams) => Promise<unknown>,
  successStatus = 200,
) {
  try {
    const context = await getAgentnodesDrive(request);
    if (!context) return NextResponse.json({ error: 'Sign in to access project skills.', code: 'UNAUTHORIZED' }, { status: 401 });
    const route = await params;
    const store = new ProjectSkillsStore(context.drive, route.project_id);
    const result = await handler(store, route);
    return NextResponse.json(result, { status: successStatus, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ code: 'INVALID_INPUT', error: 'Invalid skill data.', issues: error.flatten() }, { status: 400 });
    if (error instanceof ProjectSkillsError) return NextResponse.json({ code: error.code, error: error.message }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.json({ code: 'SKILLS_UNAVAILABLE', error: 'Project skills are temporarily unavailable. Please retry.' }, { status: 503 });
  }
}

export const RevisionActionSchema = z.object({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  version: z.number().int().positive().optional(),
}).strict();

export async function readProjectSkillSave(request: NextRequest, update: boolean): Promise<SaveProjectSkill> {
  let body: unknown;
  let upload: SkillUpload | undefined;
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const metadata = form.get('metadata');
    if (typeof metadata !== 'string') throw new ProjectSkillsError('INVALID_INPUT', 'Skill metadata is required.');
    try { body = JSON.parse(metadata); }
    catch { throw new ProjectSkillsError('INVALID_INPUT', 'Skill metadata must be valid JSON.'); }
    const file = form.get('file');
    if (file && typeof file !== 'string') {
      if (file.size > 20 * 1024 * 1024) throw new ProjectSkillsError('UPLOAD_TOO_LARGE', 'Choose a file up to 20 MB.', 413);
      upload = { name: file.name, mimeType: file.type || 'application/octet-stream', content: Buffer.from(await file.arrayBuffer()) };
    }
  } else {
    body = await request.json().catch(() => null);
  }
  const parsed = z.object({
    operationId: z.string().uuid(),
    expectedVersion: update ? z.number().int().positive() : z.undefined(),
    input: update ? ProjectSkillPatchSchema : ProjectSkillCreateSchema,
  }).strict().parse(body);
  if (!update && parsed.input.source === 'file' && !upload) throw new ProjectSkillsError('SOURCE_REQUIRED', 'The original uploaded skill file is required.');
  return { ...parsed, upload };
}

export async function resolveProjectSkillRefs(store: ProjectSkillsStore, raw: unknown) {
  const { refs } = z.object({ refs: SkillRefsSchema }).strict().parse(raw);
  await store.access();
  if (refs.some((ref) => ref.projectId !== store.projectId)) throw new ProjectSkillsError('WRONG_PROJECT', 'A skill belongs to another project.', 403);
  if (!refs.length) return { revisions: [] };
  const location = await store.location();
  if (!location) throw new ProjectSkillsError('REVISION_UNAVAILABLE', 'The project skills library is unavailable.', 409);
  const { data } = await store.readIndex(location);
  const revisions = [];
  for (const ref of refs) {
    const entry = data.skills.find((skill) => skill.skillId === ref.skillId);
    if (!entry) throw new ProjectSkillsError('REVISION_UNAVAILABLE', 'An attached skill is unavailable.', 409);
    revisions.push(await store.readRevision(location, entry, ref.version));
  }
  return { revisions };
}