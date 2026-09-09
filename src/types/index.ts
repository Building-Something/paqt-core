export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ContractRisk {
  id: string;
  text: string;
  riskLevel: RiskLevel;
  category: string;
  description: string;
  recommendation: string;
  pageNumber: number;
  searchText: string;
  relatedPages?: number[];
  verified?: boolean;
}

export interface ContractAnalysis {
  contractType: string;
  parties: string[];
  keyTerms: string[];
  risks: ContractRisk[];
  overallRiskScore: number;
  summary: string;
  recommendations: string[];
}

export interface ChatMessage {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

export interface PdfPage {
  pageNumber: number;
  text: string;
}

export interface AnalysisSession {
  id: string;
  fileName: string;
  pageCount: number;
  contractText: string;
  analysis: ContractAnalysis | null;
  createdAt: string;
  updatedAt: string;
}

export type ProgressStage =
  | 'idle'
  | 'extracting'
  | 'preparing'
  | 'analyzing'
  | 'consolidating'
  | 'synthesizing'
  | 'complete'
  | 'error';

export interface AnalysisProgress {
  stage: ProgressStage;
  label: string;
  pageRange?: string;
  from?: number;
  to?: number;
  total?: number;
  risks?: ContractRisk[];
}

export interface BuildAnalysisInput {
  contractType: string;
  parties: string[];
  keyTerms: string[];
  risks: ContractRisk[];
  overallRiskScore: number;
  summary: string;
  recommendations: string[];
}