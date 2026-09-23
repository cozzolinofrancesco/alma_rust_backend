import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { withProjectSkills, RevisionActionSchema, type ProjectSkillsParams } from '../../../../../../lib/projectSkillsApi';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, async (store, route) => {
    const input = RevisionActionSchema.parse(await request.json());
    return store.save({ operationId: input.operationId, skillId: route.skillId, expectedVersion: input.expectedVersion, restoreVersion: z.number().int().positive().parse(input.version) });
  });
}