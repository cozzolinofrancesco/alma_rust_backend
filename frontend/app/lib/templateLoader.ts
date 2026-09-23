
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

export interface StudyType {
  id: string;
  name: string;
  description: string;
  is_default?: boolean;
}

export interface TemplateData {
  id: string;
  name: string;
  description: string;
  molecule_type: string;
  study_types: string[];
  user_instruction: string;
  user_input: string;
}

export interface TemplatesResult {
  templates: Record<string, TemplateData>;
  source: 'gsheet';
}

const SHEET_COLUMNS = {
  TYPE: 0,
  INSTRUCTIONS: 1,
  KEY_WORD: 2,
};

function normalizeSheetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const m = trimmed.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m?.[1] || trimmed;
}

async function fetchFromGSheet(accessToken: string, sheetId: string): Promise<TemplatesResult | null> {
  if (!sheetId) {
    console.log('Templates sheetId not configured, skipping GSheet fetch');
    return null;
  }
  
  try {
    const range = encodeURIComponent('Templates!A2:C');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
    
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      console.error('GSheet fetch failed:', {
        status: response.status,
        statusText: response.statusText,
        sheetId,
        range: 'Templates!A2:C',
        url,
        body: bodyText.slice(0, 500),
      });
      return null;
    }
    
    const data = await response.json();
    const rows = data.values || [];
    
    if (rows.length === 0) {
      console.warn('GSheet returned empty data');
      return null;
    }
    
    const templates: Record<string, TemplateData> = {};
    
    rows.forEach((row: string[], index: number) => {
      const typeRaw = (row[SHEET_COLUMNS.TYPE] || '').trim();
      const userInstruction = (row[SHEET_COLUMNS.INSTRUCTIONS] || '').trim();
      const keywordsRaw = (row[SHEET_COLUMNS.KEY_WORD] || '').trim();
      
      if (!typeRaw || !userInstruction) {
        console.warn(`Skipping row ${index + 2}: missing required fields (TYPE or INSTRUCTIONS)`);
        return;
      }
      
      const templateKey = `template_${index + 1}`;
      
      const templateId = `template-${index + 1}-${typeRaw.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;
      const name = typeRaw;
      
      const description = userInstruction.split('\n')[0].replace(/\*\*/g, '').trim() || name;
      
      const studyTypes = keywordsRaw
        ? (keywordsRaw.includes('\n')
            ? keywordsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
            : keywordsRaw.split(',').map((s) => s.trim()).filter(Boolean))
        : [];
      
      templates[templateKey] = {
        id: templateId,
        name,
        description,
        molecule_type: 'any',
        study_types: studyTypes,
        user_instruction: userInstruction,
        user_input: '',
      };
    });
    
    console.log(`Loaded ${Object.keys(templates).length} templates from Google Sheets`);
    return { templates, source: 'gsheet' };
    
  } catch (error) {
    console.error('GSheet fetch error:', error);
    return null;
  }
}

export async function loadTemplates(
  accessToken?: string,
  options?: { sheetId?: string; yamlText?: string }
): Promise<TemplatesResult | null> {
  if (options?.yamlText) {
    try {
      const parsed = loadTemplatesFromYamlText(options.yamlText);
      if (parsed && Object.keys(parsed.templates).length > 0) {
        return parsed;
      }
    } catch (error) {
      console.error('Failed to parse uploaded YAML:', error);
    }
  }

  const configSheetId = process.env.TEMPLATES_SHEET_ID || '';
  const userSheetId = options?.sheetId || '';
  const sheetIdRaw = userSheetId || configSheetId;
  const sheetId = normalizeSheetId(sheetIdRaw);

  if (!accessToken) {
    console.error('No access token provided for GSheet fetch');
    return null;
  }

  if (!sheetId) {
    console.error('No TEMPLATES_SHEET_ID configured in environment');
    return null;
  }

  const gsheetResult = await fetchFromGSheet(accessToken, sheetId);
  if (!gsheetResult) {
    console.error('Failed to load templates from GSheet', {
      sheetId,
      sheetIdWasUrl: sheetIdRaw.includes('spreadsheets/d/'),
    });
    return null;
  }

  return gsheetResult;
}

export function loadTemplatesFromYamlText(yamlText: string): TemplatesResult | null {
  try {
    const parsed = yaml.load(yamlText) as { templates?: Record<string, TemplateData> } | null;
    if (!parsed || !parsed.templates || typeof parsed.templates !== 'object') {
      console.warn('Invalid templates YAML structure');
      return null;
    }
    return { templates: parsed.templates, source: 'gsheet' as const };
  } catch (error) {
    console.error('Failed to parse templates YAML:', error);
    return null;
  }
}

export function loadStudyTypes(): StudyType[] {
  try {
    const yamlPath = path.join(process.cwd(), 'templates', 'study-types.yaml');
    const fileContent = fs.readFileSync(yamlPath, 'utf8');
    return loadStudyTypesFromYamlText(fileContent);
  } catch (error) {
    console.error('Failed to load study types from YAML:', error);
    return [];
  }
}

export function loadStudyTypesFromYamlText(yamlText: string): StudyType[] {
  try {
    const parsed = yaml.load(yamlText) as { study_types?: StudyType[] } | null;
    if (!parsed || !Array.isArray(parsed.study_types)) {
      console.warn('Invalid study types YAML structure');
      return [];
    }
    return parsed.study_types;
  } catch (error) {
    console.error('Failed to parse study types YAML:', error);
    return [];
  }
}

export async function fetchStudyTypesFromGSheet(
  accessToken: string,
  sheetId: string
): Promise<StudyType[] | null> {
  if (!sheetId) {
    console.log('Study types sheetId not configured, skipping GSheet fetch');
    return null;
  }

  try {
    const range = encodeURIComponent('StudyTypes!A2:D');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      console.error('GSheet fetch failed for study types:', {
        status: response.status,
        statusText: response.statusText,
        sheetId,
        body: bodyText.slice(0, 500),
      });
      return null;
    }

    const data = await response.json();
    const rows = data.values || [];

    if (rows.length === 0) {
      console.warn('GSheet returned empty study types data');
      return null;
    }

    const studyTypes: StudyType[] = rows
      .map((row: string[]) => {
        const id = (row[0] || '').trim();
        const name = (row[1] || '').trim();
        const description = (row[2] || '').trim();
        const isDefault = (row[3] || '').trim().toLowerCase() === 'true';

        if (!id || !name) return null;

        return {
          id,
          name,
          description,
          ...(isDefault ? { is_default: true } : {}),
        };
      })
      .filter((st: StudyType | null): st is StudyType => st !== null);

    console.log(`Loaded ${studyTypes.length} study types from Google Sheets`);
    return studyTypes;
  } catch (error) {
    console.error('GSheet fetch error for study types:', error);
    return null;
  }
}
