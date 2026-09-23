import { NetworkGraphData, SequenceDiagramData } from '../types';
import { requestValidationAnalysis } from '@/app/lib/validationAnalysis/client';

export async function analyzeClaimsEvidenceFromCorpus(
  corpusId: string,
  model?: string
): Promise<SequenceDiagramData> {
  return requestValidationAnalysis({ mode: 'claims', corpusIds: [corpusId], model });
}

export async function analyzeReferenceNetworkFromCorpus(
  corpusId: string,
  step1Data: SequenceDiagramData,
  model?: string
): Promise<NetworkGraphData> {
  return requestValidationAnalysis({ mode: 'references', corpusIds: [corpusId], step1: step1Data, model });
}
