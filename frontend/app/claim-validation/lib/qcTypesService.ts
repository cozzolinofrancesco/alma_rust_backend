import type { QcType } from '@/app/claim-validation/types';

export function normalizeSheetId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const m = trimmed.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m?.[1] ?? trimmed;
}

export async function fetchQcTypesFromGSheet(
  accessToken: string,
  sheetId: string
): Promise<QcType[] | null> {
  if (!sheetId) return null;

  try {
    const range = encodeURIComponent('QC_Prompt!A2:D');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('[qc-types] GSheet fetch failed:', {
        status: response.status,
        body: body.slice(0, 500),
      });
      return null;
    }

    const data = (await response.json()) as { values?: string[][] };
    const rows = data.values ?? [];

    if (rows.length === 0) {
      console.warn('[qc-types] QC_Prompt sheet returned no data rows');
      return null;
    }

    const qcTypes: QcType[] = [];

    rows.forEach((row, index) => {
      const label            = (row[0] ?? '').trim();
      const description      = (row[1] ?? '').trim();
      const extractionPrompt = (row[2] ?? '').trim();
      const validationPrompt = (row[3] ?? '').trim();

      if (!label || !extractionPrompt || !validationPrompt) {
        console.warn(
          `[qc-types] Skipping row ${index + 2}: ` +
          `missing label, extraction prompt (col C), or extract-claim prompt (col D)`
        );
        return;
      }

      const slug = label.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(0, 50);

      qcTypes.push({
        qc_type_id:                 `sheet-qc-${index + 1}-${slug}`,
        label,
        description:                description || label,
        extraction_prompt_template: extractionPrompt,
        validation_prompt_template: validationPrompt,
        claim_types: [
          'NUMERICAL', 'STATISTICAL', 'SAFETY', 'EFFICACY',
          'PHARMACOKINETIC', 'PHARMACODYNAMIC', 'MECHANISTIC', 'GENERAL',
        ],
        source_type: 'config',
        version:     '1.0',
      });
    });

    if (qcTypes.length === 0) {
      console.warn('[qc-types] GSheet returned rows but none had valid data');
      return null;
    }

    console.log(`[qc-types] Loaded ${qcTypes.length} QC type(s) from Google Sheets`);
    return qcTypes;
  } catch (error) {
    console.error('[qc-types] GSheet fetch error:', error);
    return null;
  }
}

export const QC_TYPE_REGISTRY: QcType[] = [
  {
    qc_type_id: 'investigator-brochure-claim-verification',
    label:       'Investigator Brochure Claim Verification',
    description: 'Extracts atomic scientific claims from a document and validates each claim against cited source evidence in a RAG corpus, returning a structured, auditable assessment of whether the claim is supported, partially supported, contradicted, or not substantiated.',
    extraction_prompt_template: `You are an expert regulatory reviewer. Extract every atomic, verifiable claim from the uploaded document.

RULES
1. One claim per entry — split compound sentences into separate claims.
2. Copy the exact verbatim wording from the document into CLAIM_TEXT.
3. Set CLAIM_REF to the citation marker(s) in the text (e.g. "[14]", "[2,5]"), or null if none.
4. Set SOURCE_PAGE to the page number as an integer, or null if unavailable.
5. Do not infer, merge, generalise, or fabricate.

EXAMPLES

Input: "Treatment with 50 mg resulted in a 25% reduction in tumor volume [14]."
Output: { "CLAIM_TEXT": "Treatment with 50 mg resulted in a 25% reduction in tumor volume [14].", "CLAIM_REF": "[14]", "SOURCE_PAGE": 12 }

Input: "At 100 mg, the drug reduced tumor volume by 30% and increased median survival by 12 days [18]."
Output (split into two atomic claims):
{ "CLAIM_TEXT": "At 100 mg, the drug reduced tumor volume by 30% [18].", "CLAIM_REF": "[18]", "SOURCE_PAGE": 14 }
{ "CLAIM_TEXT": "At 100 mg, the drug increased median survival by 12 days [18].", "CLAIM_REF": "[18]", "SOURCE_PAGE": 14 }

OUTPUT
Return strict JSON only — no markdown, no explanation, nothing before or after.

{
  "claims": [
    {
      "CLAIM_TEXT": "string",
      "CLAIM_REF": "string or null",
      "SOURCE_PAGE": 0
    }
  ]
}`,
    validation_prompt_template: `You are an expert regulatory reviewer performing source data verification.

INPUTS

CLAIM_TEXT: {{CLAIM_TEXT}}
SOURCE_PAGE: {{SOURCE_PAGE}}
CLAIM_REF: {{CLAIM_REF}}

RAG_EVIDENCE:
{{RAG_EVIDENCE}}

DECISION STANDARD

Compare the claim against the retrieved evidence only.
Do not rely on outside knowledge.
Do not assume the claim is correct.
Do not invent support if the evidence is weak or absent.

STATUS
MATCHING — evidence directly supports the claim in meaning, values, and context.
PARTIALLY_MATCHING — core finding is supported but with a minor discrepancy, rounding, wording shift, or incomplete alignment.
NOT_MATCHING — evidence contradicts the claim or shows the claim misrepresents the source.
SOURCE_NOT_FOUND — claim cannot be located or substantiated in the retrieved evidence.

SUPPORT_STRENGTH
STRONG — evidence is direct, explicit, and specific.
MODERATE — evidence supports reasonably well but not completely.
WEAK — evidence is indirect, ambiguous, or loosely aligned.
NONE — no meaningful support present.

ACTION
NO_ACTION_NEEDED — use when STATUS = MATCHING.
CORRECT_VALUE_OR_UNIT — minor numerical, unit, or precision discrepancy.
CLARIFY_WORDING — claim is broadly supported but wording is overstated or ambiguous.
VERIFY_REFERENCE — use when STATUS = SOURCE_NOT_FOUND.
FLAG_FOR_MEDICAL_REVIEW — use when STATUS = NOT_MATCHING or discrepancy is clinically significant.

INSTRUCTIONS
1. Assign one STATUS.
2. Assign one SUPPORT_STRENGTH.
3. Assign one ACTION.
4. Extract the single best verbatim quote from the evidence (RAG_QUOTE), or empty string if none.
5. Note the source location — page, section, table, or figure — in RAG_LOCATION, or null.
6. Set CONTRADICTION_PRESENT to true only if the evidence contradicts the claim.
7. Set INSUFFICIENT_EVIDENCE to true when evidence is absent, too weak, or too incomplete.
8. Keep RATIONALE concise and evidence-based.

OUTPUT
Return strict JSON only — no markdown, no explanation, nothing before or after.

{
  "RAG_QUOTE": "string",
  "RAG_LOCATION": "string or null",
  "STATUS": "MATCHING | PARTIALLY_MATCHING | NOT_MATCHING | SOURCE_NOT_FOUND",
  "SUPPORT_STRENGTH": "STRONG | MODERATE | WEAK | NONE",
  "CONTRADICTION_PRESENT": false,
  "INSUFFICIENT_EVIDENCE": false,
  "ACTION": "NO_ACTION_NEEDED | CORRECT_VALUE_OR_UNIT | CLARIFY_WORDING | VERIFY_REFERENCE | FLAG_FOR_MEDICAL_REVIEW",
  "RATIONALE": "string"
}`,
    claim_types:  ['NUMERICAL', 'STATISTICAL', 'SAFETY', 'EFFICACY', 'PHARMACOKINETIC', 'PHARMACODYNAMIC', 'MECHANISTIC', 'GENERAL'],
    source_type:  'config',
    version:      '1.0',
  },
];
