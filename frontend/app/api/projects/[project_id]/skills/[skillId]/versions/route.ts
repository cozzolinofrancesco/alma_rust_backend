import type { NextRequest } from 'next/server';
import { withProjectSkills, type ProjectSkillsParams } from '../../../../../../lib/projectSkillsApi';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<ProjectSkillsParams> }) {
  return withProjectSkills(request, params, async (store, route) => {
    const { entry } = await store.detail(route.skillId!);
    return { versions: entry.revisions };
  });
}