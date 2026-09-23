import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { withProjectSkills, readProjectSkillSave, RevisionActionSchema, type ProjectSkillsParams } from '../../../../../lib/projectSkillsApi';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, (store, route) => {
    const version = request.nextUrl.searchParams.get('version');
    return store.detail(route.skillId!, version ? z.coerce.number().int().positive().parse(version) : undefined);
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, async (store, route) => store.save({ ...await readProjectSkillSave(request, true), skillId: route.skillId }));
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, async (store, route) => {
    const input = RevisionActionSchema.parse(await request.json());
    return { entry: await store.archive(route.skillId!, input.expectedVersion, input.operationId) };
  });
}