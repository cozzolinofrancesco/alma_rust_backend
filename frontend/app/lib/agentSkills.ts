import { z } from 'zod';
import { SkillAppearanceSchema, type SkillAppearance } from './skillAppearance';

// A Skill is a reusable, system-level prompt that applies on top of every step
// of an agent. Skills live in a global per-user library (see skills-gdrive.ts);
// agents reference them by id (metadata.skillIds) and resolve to text at run
// time, so editing a skill propagates to every agent that references it.

export const SKILL_SOURCES = ['typed', 'file', 'gdoc'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

export interface Skill {
  id: string;
  label: string;
  icon?: string;
  appearance?: SkillAppearance;
  text: string;
  source?: SkillSource;
  createdAt: string;
  updatedAt: string;
}

export const SkillSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  icon: z.string().max(16).optional(),
  appearance: SkillAppearanceSchema.optional(),
  text: z.string().min(1),
  source: z.enum(SKILL_SOURCES).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Payload accepted when creating a skill (server fills id/timestamps).
export const SkillCreateSchema = z.object({
  label: z.string().min(1).max(120),
  icon: z.string().max(16).optional(),
  appearance: SkillAppearanceSchema.optional(),
  text: z.string().min(1),
  source: z.enum(SKILL_SOURCES).optional(),
});
export type SkillCreateInput = z.infer<typeof SkillCreateSchema>;

// Payload accepted when patching a skill — any subset of editable fields.
export const SkillUpdateSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    icon: z.string().max(16).optional(),
    appearance: SkillAppearanceSchema.optional(),
    text: z.string().min(1).optional(),
    source: z.enum(SKILL_SOURCES).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided',
  });
export type SkillUpdateInput = z.infer<typeof SkillUpdateSchema>;

export const SkillsFileSchema = z.object({
  version: z.literal(1),
  skills: z.array(SkillSchema),
});
export type SkillsFile = z.infer<typeof SkillsFileSchema>;

// Resolve an agent's referenced skill ids to their library texts, preserving
// reference order and silently skipping ids no longer present in the library
// (a deleted skill simply contributes no text — never throws).
export const resolveSkillTexts = (
  skillIds: readonly string[] | undefined,
  skillsById: ReadonlyMap<string, Skill>,
): string[] => {
  if (!skillIds || skillIds.length === 0) return [];
  const texts: string[] = [];
  for (const id of skillIds) {
    const skill = skillsById.get(id);
    const text = skill?.text?.trim();
    if (text) texts.push(text);
  }
  return texts;
};

export const skillsByIdMap = (skills: readonly Skill[]): Map<string, Skill> =>
  new Map(skills.map((s) => [s.id, s]));
