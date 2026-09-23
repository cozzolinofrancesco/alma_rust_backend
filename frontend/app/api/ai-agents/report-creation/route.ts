import { NextResponse } from 'next/server';
import { getApiSession } from '@/app/lib/apiCaller.server';
import { DEFAULT_MODEL } from '../../../lib/modelConfig';
import { loadTemplates } from '../../../lib/templateLoader';
import {
  sec1SelectionRequiresBiomaterialCorpus,
} from '../../../lib/reportCreationLayerRefs';
import {
  fetchSect1MetaStepsFromSheet,
  type Sect1MetaStepRow,
} from '../../../lib/sect1MetaSteps';
import {
  buildReportCreationAgent,
  META_SECTION_PROMPT_FALLBACK,
  type ReportStudy as StudyInput,
  type ReportSectionStep as Sec3StepInput,
  type ReportSectionStep as Sec1StepInput,
  type ReportMetaFile as MetaFileInput,
} from '../../../lib/reportCreation/compiler';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      agentName,
      studies,
      sec3Steps,
      sec1Steps,
      sect1MetaSteps,
      metaFiles,
      metaCorpusId,
      metaCorpusName,
      model,
      templatesSource,
      templatesSheetId,
      templatesYamlText,
      corpusId,
      corpusName,
      sharedMetaInstruction,
      reportCreationDisplayName,
      biomaterialSkipped: biomaterialSkippedRaw,
    } = body as {
      agentName: string;
      studies: StudyInput[];
      sec3Steps?: Sec3StepInput[];
      sec1Steps?: Sec1StepInput[];
      sect1MetaSteps?: Array<{
        id?: string;
        typeName: string;
        instruction: string;
        keywords?: string[];
        userInput?: string;
      }>;
      metaFiles?: MetaFileInput[];
      metaCorpusId?: string;
      metaCorpusName?: string;
      sharedMetaInstruction?: string;
      model?: string;
      templatesSource?: 'default' | 'gsheet' | 'upload';
      templatesSheetId?: string;
      templatesYamlText?: string;
      corpusId?: string;
      corpusName?: string;
      reportCreationDisplayName?: string;
      biomaterialSkipped?: boolean;
    };

    const biomaterialSkipped = Boolean(biomaterialSkippedRaw);
    const rawMetaFiles = Array.isArray(metaFiles) ? metaFiles : [];
    const effectiveMetaFiles = biomaterialSkipped ? [] : rawMetaFiles;
    const effectiveMetaCorpusId = biomaterialSkipped ? undefined : metaCorpusId;

    if (!agentName || !studies || studies.length === 0) {
      return NextResponse.json(
        { error: 'Agent name and at least one study are required' },
        { status: 400 }
      );
    }

    const sec1StepsInput = Array.isArray(sec1Steps) ? sec1Steps : [];
    if (biomaterialSkipped && rawMetaFiles.length > 0) {
      return NextResponse.json(
        {
          error:
            'biomaterialSkipped cannot be used with biomaterial PDFs. Remove meta files or clear the skip.',
        },
        { status: 400 }
      );
    }
    if (
      !biomaterialSkipped &&
      effectiveMetaFiles.length === 0 &&
      sec1SelectionRequiresBiomaterialCorpus(sec1StepsInput)
    ) {
      return NextResponse.json(
        {
          error:
            'Section 1 includes HB_Table but no biomaterial documents were provided. Add a biomaterial corpus or use “No human biomaterial” in the wizard when HB does not apply.',
        },
        { status: 400 }
      );
    }
    if (effectiveMetaFiles.length > 0 && !effectiveMetaCorpusId) {
      return NextResponse.json(
        { error: 'metaCorpusId is required when biomaterial (meta) PDFs are included.' },
        { status: 400 }
      );
    }
    
    const selectedModel = model || DEFAULT_MODEL;
    
    const session = await getApiSession(req);
    const accessToken = (session as { accessToken?: string })?.accessToken;
    
    const templatesResult = await loadTemplates(accessToken, {
      sheetId: templatesSource === 'gsheet' ? (templatesSheetId || '') : undefined,
      yamlText: templatesSource === 'upload' ? (templatesYamlText || '') : undefined,
    });
    if (!templatesResult) {
      console.error('Failed to load templates configuration', { templatesSource, templatesSheetId });
      return NextResponse.json(
        { error: 'Failed to load templates configuration' },
        { status: 500 }
      );
    }
    
    const templatesData = templatesResult;

    const sheetIdForMeta =
      (templatesSheetId && String(templatesSheetId).trim()) ||
      process.env.TEMPLATES_SHEET_ID ||
      '';

    let metaStepRows: Sect1MetaStepRow[] = [];
    if (sect1MetaSteps !== undefined && Array.isArray(sect1MetaSteps)) {
      metaStepRows = sect1MetaSteps.map((s, i) => ({
        id: s.id?.trim() || `meta-template-${i + 1}`,
        typeName: (s.typeName || '').trim() || 'Biomaterial',
        instruction: (s.instruction || '').trim() || META_SECTION_PROMPT_FALLBACK,
        keywords: Array.isArray(s.keywords) ? s.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
        userInput: typeof s.userInput === 'string' ? s.userInput.trim() : undefined,
      }));
    } else if (accessToken && sheetIdForMeta && effectiveMetaFiles.length > 0) {
      try {
        metaStepRows = await fetchSect1MetaStepsFromSheet(accessToken, sheetIdForMeta);
      } catch (e) {
        console.error('report-creation: failed to load sect1MetaSteps', e);
      }
    }
    
    const agent = buildReportCreationAgent({
      agentName, studies, sec3Steps, sec1Steps: sec1StepsInput, metaFiles: effectiveMetaFiles,
      metaCorpusId: effectiveMetaCorpusId, metaCorpusName, model: selectedModel, corpusId, corpusName,
      sharedMetaInstruction, reportCreationDisplayName, biomaterialSkipped,
    }, templatesData.templates, metaStepRows);
    
    return NextResponse.json(agent);
    
  } catch (error) {
    console.error('Report creation error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate agent' },
      { status: 500 }
    );
  }
}
