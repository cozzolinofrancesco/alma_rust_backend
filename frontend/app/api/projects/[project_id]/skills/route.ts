import type { NextRequest } from 'next/server';
import { withProjectSkills, readProjectSkillSave, type ProjectSkillsParams } from '../../../../lib/projectSkillsApi';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, (store) => store.list());
}

export async function POST(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, async (store) => store.save(await readProjectSkillSave(request, false)), 201);
}