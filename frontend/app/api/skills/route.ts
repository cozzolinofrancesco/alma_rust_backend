import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAgentnodesDrive } from '../../lib/agentnodesApi/driveFromRequest';
import { listSkills, createSkill } from '../../lib/skills-gdrive';
import { SkillCreateSchema } from '../../lib/agentSkills';

export async function GET(request: NextRequest) {
  const ctx = await getAgentnodesDrive(request);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const skills = await listSkills(ctx.drive);
    return NextResponse.json({ skills });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list skills';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await getAgentnodesDrive(request);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = SkillCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid skill', issues: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const skill = await createSkill(ctx.drive, parsed.data);
    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create skill';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
