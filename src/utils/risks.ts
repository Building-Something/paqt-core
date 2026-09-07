import type { ContractRisk, RiskLevel } from '../types';

export const RISK_WEIGHTS: Record<RiskLevel, number> = {
  critical: 95,
  high: 75,
  medium: 50,
  low: 25,
};

const RISK_ORDER: Record<RiskLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function normalizeRiskText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCategory(category: string): string {
  return category.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function riskIdentity(risk: ContractRisk): string {
  const key = `${normalizeRiskText(risk.text).slice(0, 80)}`;
  return `${risk.pageNumber}|${normalizeCategory(risk.category)}|${key}`;
}

export function deduplicateRisks(risks: ContractRisk[]): ContractRisk[] {
  const seen = new Set<string>();
  const unique: ContractRisk[] = [];
  for (const risk of risks) {
    const id = riskIdentity(risk);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(risk);
  }
  return unique;
}

export function sortRisks(risks: ContractRisk[]): ContractRisk[] {
  return [...risks].sort((a, b) => {
    if (a.pageNumber !== b.pageNumber) {
      return a.pageNumber - b.pageNumber;
    }
    return RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel];
  });
}

export function assignRiskIds(risks: ContractRisk[]): ContractRisk[] {
  return risks.map((risk, index) => ({ ...risk, id: `risk-${index + 1}` }));
}

export function normalizeRisks(raw: Partial<ContractRisk>[]): ContractRisk[] {
  const fallback = {
    text: 'Clause text unavailable.',
    riskLevel: 'low' as RiskLevel,
    category: 'Uncategorized',
    description: 'No description provided.',
    recommendation: 'Review this clause with qualified counsel.',
    pageNumber: 1,
  };

  const cleaned: ContractRisk[] = raw.map((risk, index) => {
    const safe = { ...fallback, ...risk };
    const level = normalizeRiskLevel(safe.riskLevel);
    const page = Number.isFinite(Number(safe.pageNumber))
      ? Math.max(1, Math.round(Number(safe.pageNumber)))
      : 1;
    return {
      id: `tmp-${index}`,
      text: (safe.text || '').trim() || fallback.text,
      riskLevel: level,
      category: (safe.category || '').trim() || fallback.category,
      description: (safe.description || '').trim() || fallback.description,
      recommendation:
        (safe.recommendation || '').trim() || fallback.recommendation,
      pageNumber: page,
      searchText: (safe.searchText || '').trim() || extractSearchWords(safe.text),
    };
  });

  return assignRiskIds(sortRisks(deduplicateRisks(cleaned)));
}

export function normalizeRiskLevel(value: unknown): RiskLevel {
  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  if (typeof value === 'string' && levels.includes(value as RiskLevel)) {
    return value as RiskLevel;
  }
  return 'low';
}

export function extractSearchWords(text: string): string {
  const words = (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
  return words.slice(0, 6).join(' ');
}

export function computeRiskScore(risks: ContractRisk[]): number {
  if (risks.length === 0) {
    return 10;
  }
  const scores = risks.map((risk) => RISK_WEIGHTS[risk.riskLevel]);
  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const clamped = Math.min(98, Math.max(5, Math.round(average)));
  return clamped;
}

export function formatPageLabel(page: number): string {
  return `p.${page}`;
}

export const SEVERITY_META: Record<
  RiskLevel,
  { label: string; text: string; bg: string; border: string; chip: string }
> = {
  critical: {
    label: 'Critical',
    text: 'text-critical-600',
    bg: 'bg-critical-100',
    border: 'border-critical-500',
    chip: 'bg-critical-500 text-white',
  },
  high: {
    label: 'High',
    text: 'text-high-700',
    bg: 'bg-high-100',
    border: 'border-high-500',
    chip: 'bg-high-500 text-white',
  },
  medium: {
    label: 'Medium',
    text: 'text-medium-700',
    bg: 'bg-medium-100',
    border: 'border-medium-500',
    chip: 'bg-medium-500 text-white',
  },
  low: {
    label: 'Low',
    text: 'text-low-700',
    bg: 'bg-low-100',
    border: 'border-low-500',
    chip: 'bg-low-500 text-white',
  },
};

export function formatFileName(name: string): string {
  return name
    .replace(/\.[^/.]+$/, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

export type GroqErrorCode =
  | 'not_configured'
  | 'invalid_key'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'bad_request'
  | 'oversized'
  | 'invalid_json'
  | 'network'
  | 'unknown';

export function groqErrorMessage(code: GroqErrorCode): string {
  switch (code) {
    case 'not_configured':
      return 'Groq API key is not configured on the server. Add GROQ_API_KEY and restart Paqt.';
    case 'invalid_key':
      return 'Your Groq API key was rejected. Check the server environment variable.';
    case 'rate_limited':
      return 'The AI service is temporarily rate-limited. Paqt will retry automatically; try again shortly.';
    case 'timeout':
      return 'The AI analysis took too long. Try a shorter contract or try again.';
    case 'oversized':
      return 'This request is too large for the AI service. Try a shorter contract.';
    case 'bad_request':
    case 'invalid_json':
      return 'AI returned an unexpected analysis format. Please retry.';
    case 'upstream':
    case 'network':
    case 'unknown':
    default:
      return 'Something went wrong while analyzing this contract. Please try again.';
  }
}

export function sanitizedFileName(name: string, suffix: string): string {
  const safe = formatFileName(name);
  return `paqt_${safe}_${suffix}`;
}