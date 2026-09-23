import type { NextRequest } from 'next/server';
import { withProjectSkills, resolveProjectSkillRefs, type ProjectSkillsParams } from '../../../../../lib/projectSkillsApi';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, (store) => request.json().then((body) => resolveProjectSkillRefs(store, body)));
}