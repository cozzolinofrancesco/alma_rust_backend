import { NetworkGraphData, SequenceDiagramData } from '@/app/proof-validation-flow/types';
import { requestValidationAnalysis } from '@/app/lib/validationAnalysis/client';

export async function analyzeClaimsEvidenceFromCorpora(
  corpusIds: string[],
  model?: string
): Promise<SequenceDiagramData> {
  return requestValidationAnalysis({ mode: 'claims', corpusIds, model });
}

export async function analyzeReferenceNetworkFromCorpora(
  corpusIds: string[],
  step1Data: SequenceDiagramData,
  model?: string
): Promise<NetworkGraphData> {
  return requestValidationAnalysis({ mode: 'references', corpusIds, step1: step1Data, model });
}
