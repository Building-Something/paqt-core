# PAQT — DATA MODELS

```ts
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
```

## Invariants
- `pageNumber >= 1`.
- Risk quote must be grounded in extracted text.
- Risk level is always one of four allowed values.
- Score is integer 0–100.
- Missing AI fields receive safe defaults.
- UI must tolerate empty risks and unknown parties.

## Risk identity
Deduplicate using:
`pageNumber + normalized category + normalized first 80 chars of risk text`.

Sort:
1. page ascending,
2. critical,
3. high,
4. medium,
5. low.

Reassign stable display IDs after sorting.
