import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAgentnodesDrive } from '../../../lib/agentnodesApi/driveFromRequest';
import { updateSkill, deleteSkill } from '../../../lib/skills-gdrive';
import { SkillUpdateSchema } from '../../../lib/agentSkills';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const ctx = await getAgentnodesDrive(request);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { skillId } = await params;
  const parsed = SkillUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid patch', issues: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const skill = await updateSkill(ctx.drive, skillId, parsed.data);
    if (!skill) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update skill';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const ctx = await getAgentnodesDrive(request);
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { skillId } = await params;
  try {
    const ok = await deleteSkill(ctx.drive, skillId);
    if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete skill';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
