import { NetworkGraphData, NetworkLink, NetworkNode, SequenceDiagramData } from '../types';
import { enrichReferencesWithCrossRef } from './crossref';
import { requestValidationAnalysis } from '@/app/lib/validationAnalysis/client';

export interface AnalysisOptions {
  model?: string;
  temperature?: number;
}

const DEFAULT_OPTIONS: AnalysisOptions = {
  temperature: 0.1
};

export const CLAIMS_EVIDENCE_PROMPT = `
TASK: Analyze this research paper PDF and extract Claims-Evidence relationships.

OUTPUT FORMAT: Return ONLY a valid JSON object with this exact structure:
{
  "title": "Paper title",
  "participants": [
    {"id": "claims", "name": "Claims", "type": "claim"},
    {"id": "evidence", "name": "Evidence", "type": "evidence"}
  ],
  "notes": [
    {
      "id": "claim-1",
      "participant": "claims",
      "text": "Specific claim made by authors",
      "type": "claim",
      "confidence": 0.85,
      "pageReference": "p.3",
      "qualityMarkers": {
        "detected": ["sample size: n=1000", "p<0.05"],
        "inferred": ["peer-reviewed journal", "established methodology"],
        "confidenceInterval": [0.7, 0.9]
      }
    },
    {
      "id": "evidence-1", 
      "participant": "evidence",
      "text": "Evidence supporting the claim",
      "type": "evidence",
      "confidence": 0.92,
      "pageReference": "p.12",
      "qualityMarkers": {
        "detected": ["controlled experiment", "statistical analysis"],
        "inferred": ["reputable institution", "standard protocol"],
        "confidenceInterval": [0.8, 0.95]
      }
    }
  ],
  "arrows": [
    {
      "id": "arrow-1",
      "from": "claim-1",
      "to": "evidence-1", 
      "label": "Claim 1 → Evidence 1",
      "type": "supports",
      "strength": 0.88,
      "explanation": "This evidence directly validates the claim through experimental data"
    }
  ],
  "summary": {
    "totalClaims": 3,
    "totalEvidence": 5,
    "strongLinks": 4,
    "weakLinks": 1
  }
}

ANALYSIS INSTRUCTIONS:
1. Identify 3-8 main research claims made by the authors
2. Find supporting evidence for each claim (data, studies, experiments) - MULTIPLE evidence per claim is expected
3. Assess relationship strength: "supports" (>0.7), "contradicts" (<0.3), "weak" (0.3-0.7)
4. For each arrow, provide a brief explanation (1-2 sentences) of WHY this evidence supports/contradicts the claim
5. Include page references where possible
6. Calculate confidence scores (0.0-1.0) for claims and evidence quality based on DETECTED textual indicators only
7. Provide summary statistics
8. Use specific claim-X and evidence-Y IDs in arrows (not generic "claims"/"evidence")

IMPORTANT QUALITY ASSESSMENT GUIDELINES:
- DETECTED indicators: Explicitly stated sample sizes, p-values, methodology descriptions, journal names
- INFERRED indicators: Quality assessments based on writing style, citation patterns, or name recognition
- Always distinguish between what is explicitly stated vs. what is inferred from patterns
- Include confidence intervals for all quality assessments to reflect uncertainty

IMPORTANT: Return ONLY the JSON object, no markdown formatting or explanatory text.
`;

export async function analyzeClaimsEvidence(
  pdfFile: File,
  options: AnalysisOptions = {}
): Promise<string> {
  const { model, temperature } = { ...DEFAULT_OPTIONS, ...options };
  return await sendToGemini('claims', pdfFile, { model, temperature });
}

export function buildReferenceNetworkPrompt(step1Data: SequenceDiagramData): string {
  const evidencePoints = step1Data.notes?.filter((n) => n.type === 'evidence') || [];
  const limitedEvidence = evidencePoints.slice(0, 5);

  return `
TASK: Create a CITATION NETWORK (not sequence diagram) from this PDF.

CONTEXT: Evidence from Step 1:
${limitedEvidence.map(e => `- ${e.id}: ${e.text?.substring(0, 100)}...`).join('\n')}
${REFERENCE_NETWORK_PROMPT_BODY}`;
}

const REFERENCE_NETWORK_PROMPT_BODY = `
CRITICAL INSTRUCTIONS:
1. Return ONLY valid JSON (no markdown, no explanations)
2. Use NETWORK format (nodes/links), NOT sequence format (participants/notes)
3. Map evidence to their cited references/sources
4. Extract citation details for each reference

REQUIRED JSON STRUCTURE (copy exactly):
{
  "title": "Reference Network Analysis",
  "nodes": [
    {
      "id": "evidence-1",
      "label": "Evidence description",
      "type": "evidence",
      "size": 10,
      "color": "#11074A",
      "pageReference": "p.12"
    },
    {
      "id": "ref-1",
      "label": "Smith, J., & Johnson, A. (2023). Climate change impacts on biodiversity. Nature Climate Change, 13(4), 123-135. doi:10.1038/s41558-023-01234-5",
      "type": "reference",
      "size": 8,
      "color": "#4A4453",
      "credibilityScore": 0.91,
      "extractedTitle": "Climate change impacts on biodiversity",
      "extractedAuthors": ["Smith, J.", "Johnson, A."],
      "extractedYear": "2023",
      "extractedDOI": "10.1038/s41558-023-01234-5",
      "extractedJournal": "Nature Climate Change"
    }
  ],
  "links": [
    {
      "id": "link-1",
      "source": "evidence-1",
      "target": "ref-1",
      "strength": 0.88,
      "type": "cites",
      "label": "Primary source"
    }
  ],
  "summary": {
    "totalEvidence": 5,
    "totalReferences": 12,
    "totalConnections": 18,
    "avgCredibility": 0.84,
    "strongestCluster": "Climate Data Evidence"
  }
}

ANALYSIS INSTRUCTIONS:
1. Find citations/references that support each evidence point
2. Create "nodes" array with evidence nodes AND reference nodes
3. Create "links" array connecting evidence to references
4. Extract citation details for CrossRef validation
5. Use colors: evidence=#11074A, references=#4A4453

WARNING: Do NOT return sequence diagram format with "participants" and "notes"
WARNING: Do NOT use markdown code blocks (\`\`\`json)
WARNING: Return ONLY the raw JSON object

EXAMPLE STRUCTURE:
{
  "title": "Reference Network Analysis",
  "nodes": [
    {"id": "evidence-1", "type": "evidence", "label": "...", "color": "#11074A"},
    {"id": "ref-1", "type": "reference", "label": "...", "color": "#4A4453", "extractedTitle": "..."}
  ],
  "links": [{"source": "evidence-1", "target": "ref-1"}],
  "summary": {"totalEvidence": 1, "totalReferences": 1}
}
  `;

export async function analyzeReferenceNetwork(
  pdfFile: File,
  step1Data: SequenceDiagramData,
  options: AnalysisOptions = {}
): Promise<string> {
  const { model, temperature } = { ...DEFAULT_OPTIONS, ...options };
  return await sendToGemini('references', pdfFile, { model, temperature }, step1Data);
}

export async function analyzeReferenceNetworkWithCrossRef(
  pdfFile: File,
  step1Data: SequenceDiagramData,
  options: AnalysisOptions = {}
): Promise<NetworkGraphData> {
  try {
    console.log('=== STEP 2 ANALYSIS START ===');
    console.log('Step 1 data summary:', {
      title: step1Data?.title,
      notesCount: step1Data?.notes?.length,
      evidenceCount: step1Data?.notes?.filter((n) => n.type === 'evidence')?.length
    });

    console.log('Calling analyzeReferenceNetwork...');
    const enriched = await requestValidationAnalysis<NetworkGraphData>({ mode: 'references', step1: step1Data, ...options }, pdfFile);

    console.log('=== STEP 2 ANALYSIS COMPLETE ===');
    return enriched;
  } catch (error) {
    console.error('=== STEP 2 ANALYSIS FAILED ===');
    console.error('Error in analyzeReferenceNetworkWithCrossRef:', error);
    console.error('Step 1 data:', step1Data);
    throw error;
  }
}

export function parseNetworkResponse(geminiResponse: string): NetworkGraphData {
  console.log('Parsing network response...');

  try {
    const rawData = parseGeminiResponse(geminiResponse);

    if (!rawData || typeof rawData !== 'object') {
      throw new Error('Parsed data is not an object');
    }

    if ('participants' in rawData && 'notes' in rawData && !('nodes' in rawData)) {
      console.warn('Gemini returned Step 1 format, converting to Step 2 format...');
      const converted = convertStep1ToStep2Format(rawData as SequenceDiagramData);
      console.log('Successfully converted Step 1 to Step 2 format');
      return converted;
    }

    const networkRawData = rawData as NetworkGraphData;

    if (!networkRawData.nodes || !Array.isArray(networkRawData.nodes)) {
      console.warn('Missing or invalid nodes array, creating default structure');
      networkRawData.nodes = [];
    }

    if (!networkRawData.links || !Array.isArray(networkRawData.links)) {
      console.warn('Missing or invalid links array, creating default structure');
      networkRawData.links = [];
    }

    if (!networkRawData.summary || typeof networkRawData.summary !== 'object') {
      console.warn('Missing or invalid summary object, creating default structure');
      networkRawData.summary = {
        totalEvidence: 0,
        totalReferences: 0,
        totalConnections: 0,
        avgCredibility: 0,
        strongestCluster: "None"
      };
    }

    console.log('Successfully validated network data structure');
    return networkRawData;
  } catch (parseError) {
    console.warn('Failed to parse network response, using fallback data structure');
    console.error('Parse error details:', parseError);

    return {
      title: "Reference Network Analysis (Fallback)",
      nodes: [
        {
          id: "fallback-evidence",
          label: "Evidence analysis failed - using emergency fallback",
          type: "evidence",
          size: 10,
          color: "#11074A"
        }
      ],
      links: [],
      summary: {
        totalEvidence: 0,
        totalReferences: 0,
        totalConnections: 0,
        avgCredibility: 0,
        strongestCluster: "None"
      }
    };
  }
}

export async function enrichNetworkWithCrossRef(networkData: NetworkGraphData, enrich = enrichReferencesWithCrossRef): Promise<NetworkGraphData> {
  const referenceNodes = networkData.nodes.filter(node => node.type === 'reference');

  const referencesForEnrichment = referenceNodes.map(node => ({
    id: node.id,
    label: node.label,
    extractedTitle: node.extractedTitle,
    extractedAuthors: node.extractedAuthors,
    extractedYear: node.extractedYear,
    extractedDOI: node.extractedDOI
  }));

  console.log(`Enriching ${referencesForEnrichment.length} references with CrossRef data...`);
  const enrichedReferences = await enrich(referencesForEnrichment);

  const enhancedNodes = networkData.nodes.map(node => {
    if (node.type === 'reference') {
      const enrichedRef = enrichedReferences.find(ref => ref.id === node.id);
      if (enrichedRef) {
        return {
          ...node,
          crossRefData: enrichedRef.crossRefData,
          credibilityScore: enrichedRef.enhancedCredibilityScore
        };
      }
    }
    return node;
  });

  const enhancedSummary = {
    ...networkData.summary,
    avgCredibility: calculateAverageCredibility(enhancedNodes),
    crossRefValidated: enrichedReferences.filter(ref =>
      ref.crossRefData?.verificationStatus === 'verified'
    ).length,
    totalCrossRefAttempts: enrichedReferences.length
  };

  return {
    ...networkData,
    nodes: enhancedNodes,
    summary: enhancedSummary
  };
}

function convertStep1ToStep2Format(step1Data: SequenceDiagramData): NetworkGraphData {
  console.log('Converting Step 1 format to Step 2 format...');

  const nodes: NetworkNode[] = [];
  const links: NetworkLink[] = [];

  const evidenceNotes = step1Data.notes?.filter((note) => note.type === 'evidence') || [];
  evidenceNotes.forEach((note, index: number) => {
    nodes.push({
      id: note.id || `evidence - ${index + 1} `,
      label: note.text?.substring(0, 100) + '...' || 'Evidence description',
      type: 'evidence',
      size: 10,
      color: '#11074A',
      pageReference: note.pageReference || 'N/A'
    });
  });

  evidenceNotes.forEach((note, index: number) => {
    const refId = `ref - ${index + 1} `;
    nodes.push({
      id: refId,
      label: `Reference ${index + 1} (inferred from evidence)`,
      type: 'reference',
      size: 8,
      color: '#4A4453',
      credibilityScore: note.confidence || 0.8,
      extractedTitle: `Supporting Reference ${index + 1} `,
      extractedAuthors: ['Author, A.'],
      extractedYear: '2024',
      extractedDOI: '',
      extractedJournal: 'Inferred Journal'
    });

    links.push({
      id: `link - ${index + 1} `,
      source: note.id || `evidence - ${index + 1} `,
      target: refId,
      strength: note.confidence || 0.8,
      type: 'cites',
      label: 'Inferred citation'
    });
  });

  const summary = {
    totalEvidence: evidenceNotes.length,
    totalReferences: evidenceNotes.length,
    totalConnections: links.length,
    avgCredibility: evidenceNotes.reduce((sum: number, note) => sum + (note.confidence || 0.8), 0) / Math.max(evidenceNotes.length, 1),
    strongestCluster: 'Converted Evidence Cluster'
  };

  return {
    title: step1Data.title || 'Reference Network Analysis (Converted)',
    nodes,
    links,
    summary
  };
}

function calculateAverageCredibility(nodes: NetworkNode[]): number {
  const referenceNodes = nodes.filter(node =>
    node.type === 'reference' && typeof node.credibilityScore === 'number'
  );

  if (referenceNodes.length === 0) return 0;

  const totalScore = referenceNodes.reduce((sum, node) => sum + (node.credibilityScore || 0), 0);
  return totalScore / referenceNodes.length;
}

async function sendToGemini(
  mode: 'claims' | 'references',
  pdfFile: File,
  options: AnalysisOptions,
  step1?: SequenceDiagramData
): Promise<string> {
  return JSON.stringify(await requestValidationAnalysis({ mode, step1, ...options, enrichReferences: false }, pdfFile));
}

export function parseGeminiResponse(response: string): SequenceDiagramData | NetworkGraphData {
  console.log('=== GEMINI RESPONSE DEBUG ===');
  console.log('Raw response length:', response.length);
  console.log('Raw response type:', typeof response);
  console.log('Raw response preview (first 500 chars):', response.substring(0, 500));
  console.log('Raw response ending (last 200 chars):', response.substring(Math.max(0, response.length - 200)));

  console.log('=== FULL RESPONSE START ===');
  for (let i = 0; i < response.length; i += 1000) {
    console.log(`Chunk ${Math.floor(i / 1000) + 1}: `, response.substring(i, i + 1000));
  }
  console.log('=== FULL RESPONSE END ===');

  if (!response || typeof response !== 'string') {
    console.error('Invalid response type or empty response');
    throw new Error('Response is not a valid string');
  }

  if (response.length === 0) {
    console.error('Empty response from Gemini');
    throw new Error('Empty response from Gemini API');
  }

  if (response.length > 100000) {
    console.warn('Response is very large:', response.length, 'characters');
  }

  if (!response.includes('{') && !response.includes('[')) {
    console.error('Response does not contain any JSON-like content');
    console.error('Response appears to be plain text:', response.substring(0, 200));
    throw new Error('Response does not contain JSON content');
  }

  try {
    let cleanResponse = response.trim();

    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const jsonStart = cleanResponse.indexOf('{');
    const jsonEnd = cleanResponse.lastIndexOf('}');

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleanResponse = cleanResponse.substring(jsonStart, jsonEnd + 1);
    }

    cleanResponse = cleanResponse.replace(/,(\s*[}\]])/g, '$1');

    let needsAggressiveCleaning = false;
    try {
      JSON.parse(cleanResponse);
    } catch (testError: unknown) {
      console.warn("Initial JSON parse failed, aggressive cleaning may be needed:", testError);
      needsAggressiveCleaning = true;
    }

    if (needsAggressiveCleaning) {
      console.log('JSON appears malformed, applying aggressive cleaning...');

      cleanResponse = cleanResponse.replace(/\/\/.*$/gm, '');
      cleanResponse = cleanResponse.replace(/\/\*[\s\S]*?\*\//g, '');

      cleanResponse = cleanResponse.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    } else {
      console.log('JSON appears valid, skipping aggressive cleaning');
    }

    console.log('Cleaned response length:', cleanResponse.length);
    console.log('Cleaned response preview:', cleanResponse.substring(0, 300));

    let parsed;

    try {
      parsed = JSON.parse(cleanResponse);
      console.log('Successfully parsed JSON with keys:', Object.keys(parsed));
      return parsed;
    } catch (firstError) {
      console.warn('First JSON parse attempt failed, trying fallback strategies...');

      const bracketMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (bracketMatch) {
        try {
          parsed = JSON.parse(bracketMatch[0]);
          console.log('Fallback 1 successful - extracted main object');
          return parsed;
        } catch (fallback1Error) {
          console.warn('Fallback 1 failed:', fallback1Error instanceof Error ? fallback1Error.message : 'Unknown error');
        }
      }

      let fallback2Response = cleanResponse;
      fallback2Response = fallback2Response.replace(/'/g, '"');
      fallback2Response = fallback2Response.replace(/\bTrue\b/g, 'true');
      fallback2Response = fallback2Response.replace(/\bFalse\b/g, 'false');
      fallback2Response = fallback2Response.replace(/\bNone\b/g, 'null');

      try {
        parsed = JSON.parse(fallback2Response);
        console.log('Fallback 2 successful - fixed common issues');
        return parsed;
      } catch (fallback2Error) {
        console.warn('Fallback 2 failed:', fallback2Error instanceof Error ? fallback2Error.message : 'Unknown error');
      }

      throw firstError;
    }

  } catch (error) {
    console.error('=== JSON PARSING FAILED ===');
    console.error('Parse error:', error);
    console.error('Full raw response:', response);
    console.error('Attempted to parse:', response.substring(0, 1000));

    if (error instanceof SyntaxError) {
      const match = error.message.match(/position (\d+)/);
      if (match) {
        const position = parseInt(match[1]);
        const context = response.substring(Math.max(0, position - 50), position + 50);
        console.error(`Syntax error near position ${position}:`, context);
      }
    }

    console.warn('=== USING EMERGENCY FALLBACK DATA ===');
    const emergencyFallback: NetworkGraphData = {
      title: "Reference Network Analysis (Emergency Fallback)",
      nodes: [
        {
          id: "emergency-evidence-1",
          label: "Unable to parse Gemini response - using fallback data",
          type: "evidence",
          size: 10,
          color: "#11074A",
          pageReference: "N/A"
        },
        {
          id: "emergency-ref-1",
          label: "Gemini response parsing failed - please check console for details",
          type: "reference",
          size: 8,
          color: "#4A4453",
          credibilityScore: 0.5,
          extractedTitle: "Parsing Error",
          extractedAuthors: ["System"],
          extractedYear: "2024",
          extractedDOI: "",
          extractedJournal: "Error Log"
        }
      ],
      links: [
        {
          id: "emergency-link-1",
          source: "emergency-evidence-1",
          target: "emergency-ref-1",
          strength: 0.1,
          type: "cites",
          label: "Parsing failed"
        }
      ],
      summary: {
        totalEvidence: 1,
        totalReferences: 1,
        totalConnections: 1,
        avgCredibility: 0.5,
        strongestCluster: "Error Recovery"
      }
    };

    console.log('Emergency fallback data:', emergencyFallback);
    return emergencyFallback;
  }
} 