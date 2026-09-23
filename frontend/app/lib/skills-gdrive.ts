import type { drive_v3 } from 'googleapis';
import {
  type Skill,
  type SkillCreateInput,
  type SkillUpdateInput,
  type SkillsFile,
  SkillsFileSchema,
} from './agentSkills';

// Global, per-user skills library stored as a single JSON file in the signed-in
// user's own Google Drive. The file lives in the folder named by
// SKILLS_LIBRARY_FOLDER_ID (falling back to the user's Drive root), so it is
// visible to every project/agent for that user. Mirrors the single-array
// storage pattern used by prompts-gdrive.ts (_votes_tracking.json).

const SKILLS_FILE_NAME = '__skills_library__.json';

const resolveFolderId = (): string => process.env.SKILLS_LIBRARY_FOLDER_ID || 'root';

const newSkillId = (): string =>
  `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface SkillsFileHandle {
  fileId: string;
  data: SkillsFile;
}

const emptyFile = (): SkillsFile => ({ version: 1, skills: [] });

const parseSkillsFile = (raw: unknown): SkillsFile => {
  const parsed = SkillsFileSchema.safeParse(
    typeof raw === 'string' ? JSON.parse(raw) : raw,
  );
  return parsed.success ? parsed.data : emptyFile();
};

// Find (or create on first use) the library file and return its id + contents.
async function getSkillsFile(drive: drive_v3.Drive): Promise<SkillsFileHandle> {
  const folderId = resolveFolderId();
  const search = await drive.files.list({
    q: `name='${SKILLS_FILE_NAME}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existing = search.data.files?.[0];
  if (existing?.id) {
    const file = await drive.files.get(
      { fileId: existing.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'json' },
    );
    return { fileId: existing.id, data: parseSkillsFile(file.data) };
  }

  const initial = emptyFile();
  const created = await drive.files.create({
    requestBody: {
      name: SKILLS_FILE_NAME,
      mimeType: 'application/json',
      parents: [folderId],
    },
    media: { mimeType: 'application/json', body: JSON.stringify(initial, null, 2) },
    fields: 'id',
    supportsAllDrives: true,
  });
  return { fileId: created.data.id!, data: initial };
}

async function writeSkillsFile(
  drive: drive_v3.Drive,
  fileId: string,
  data: SkillsFile,
): Promise<void> {
  await drive.files.update({
    fileId,
    media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) },
    supportsAllDrives: true,
  });
}

export async function listSkills(drive: drive_v3.Drive): Promise<Skill[]> {
  const { data } = await getSkillsFile(drive);
  return data.skills;
}

export async function createSkill(
  drive: drive_v3.Drive,
  input: SkillCreateInput,
): Promise<Skill> {
  const { fileId, data } = await getSkillsFile(drive);
  const now = new Date().toISOString();
  const skill: Skill = {
    id: newSkillId(),
    label: input.label,
    icon: input.icon,
    appearance: input.appearance,
    text: input.text,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  const next: SkillsFile = { ...data, skills: [...data.skills, skill] };
  await writeSkillsFile(drive, fileId, next);
  return skill;
}

export async function updateSkill(
  drive: drive_v3.Drive,
  skillId: string,
  patch: SkillUpdateInput,
): Promise<Skill | null> {
  const { fileId, data } = await getSkillsFile(drive);
  const idx = data.skills.findIndex((s) => s.id === skillId);
  if (idx === -1) return null;
  const updated: Skill = {
    ...data.skills[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const skills = [...data.skills];
  skills[idx] = updated;
  await writeSkillsFile(drive, fileId, { ...data, skills });
  return updated;
}

export async function deleteSkill(
  drive: drive_v3.Drive,
  skillId: string,
): Promise<boolean> {
  const { fileId, data } = await getSkillsFile(drive);
  const skills = data.skills.filter((s) => s.id !== skillId);
  if (skills.length === data.skills.length) return false;
  await writeSkillsFile(drive, fileId, { ...data, skills });
  return true;
}
