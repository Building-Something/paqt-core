import type { ContractAnalysis, ContractRisk, PdfPage, ProgressStage } from '../types';
import {
  ANALYSIS_CONTEXT_LIMIT,
  BATCH_MAX_TOKENS,
  INTERACTION_FULL_TEXT_CHAR_LIMIT,
  INTERACTION_MAX_TOKENS,
  SINGLE_CALL_MAX_CHARS,
  SINGLE_CALL_MAX_PAGES,
} from '../constants/pipeline';
import { buildPageMarkers, extractContractText } from './pdfService';
import { GroqServiceError } from './errors';
import { computeRiskScore, normalizeRisks } from '../utils/risks';
import { keepVerifiedRisks, verifyRisksAgainstPages } from '../utils/riskVerify';
import { parseJsonObject } from '../utils/json';
import { groupPagesIntoBatches } from '../utils/batching';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const JSON_MAX_TOKENS = 4096;
const CHAT_MAX_TOKENS = 2048;

export type ReasoningEffort = 'low' | 'medium' | 'high';

interface GroqCompletionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface GroqCompletionRequest {
  messages: GroqCompletionMessage[];
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: ReasoningEffort;
  response_format?: { type: 'json_object' };
}

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
}

interface GroqErrorBody {
  error?: { code?: string; message?: string };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function callGroq(
  payload: GroqCompletionRequest,
  attempt = 1,
): Promise<string> {
  try {
    const response = await fetch('/api/groq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }

    if (!response.ok) {
      let parsed: GroqErrorBody | null = null;
      try {
        parsed = JSON.parse(bodyText) as GroqErrorBody;
      } catch {
        parsed = null;
      }
      const code = parsed?.error?.code || 'unknown';
      const message =
        parsed?.error?.message || 'The AI service returned an unexpected response.';

      if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
        const delay = attempt * BACKOFF_BASE_MS;
        await sleep(delay);
        return callGroq(payload, attempt + 1);
      }
      throw new GroqServiceError(code, message, response.status);
    }

    let parsed: GroqChatResponse;
    try {
      parsed = JSON.parse(bodyText) as GroqChatResponse;
    } catch {
      throw new GroqServiceError(
        'invalid_json',
        'AI returned an unexpected analysis format. Please retry.',
      );
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new GroqServiceError(
        'invalid_json',
        'AI returned an unexpected analysis format. Please retry.',
      );
    }
    return content;
  } catch (error) {
    if (error instanceof GroqServiceError) {
      throw error;
    }
    if (error instanceof TypeError) {
      // Network failure or proxy unavailable.
      if (attempt < MAX_ATTEMPTS) {
        const delay = attempt * BACKOFF_BASE_MS;
        await sleep(delay);
        return callGroq(payload, attempt + 1);
      }
      throw new GroqServiceError('network', 'Could not reach Paqt analysis service.');
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function groqJsonRequest(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = JSON_MAX_TOKENS,
  options: { reasonEffort?: ReasoningEffort; jsonMode?: boolean } = {},
): Promise<unknown> {
  const content = await callGroq({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    reasoning_effort: options.reasonEffort,
    response_format:
      options.jsonMode === false
        ? undefined
        : { type: 'json_object' },
  });
  return parseJsonObject(content);
}

export async function groqTextRequest(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = CHAT_MAX_TOKENS,
  temperature = 0.4,
): Promise<string> {
  return callGroq({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  });
}

const JSON_SYSTEM_PROMPT = [
  'You are a precise contract risk analyst.',
  'Return valid JSON only.',
  'Follow the exact schema in the request.',
  'Do not invent text. Quote only from the supplied contract pages.',
  'Use page numbers only from the supplied page markers.',
  'Never claim to provide legal advice.',
].join(' ');

const FULL_ANALYSIS_SCHEMA = `
{
  "contractType": "string",
  "parties": ["string"],
  "keyTerms": ["string"],
  "risks": [
    {
      "id": "string",
      "text": "exact 10-30 word clause quote from the supplied text",
      "riskLevel": "low|medium|high|critical",
      "category": "string",
      "description": "string",
      "recommendation": "string",
      "pageNumber": 1,
      "searchText": "string of 5-10 searchable words from the clause"
    }
  ],
  "overallRiskScore": 0,
  "summary": "string",
  "recommendations": ["string"]
}`;

const SEVERITY_GUIDANCE = `
Severity guidance:
- critical: significant financial/legal exposure or highly consequential unfavorable provision.
- high: materially unfavorable term worth negotiating.
- medium: ambiguity, moderate disadvantage, or meaningful clarification.
- low: minor concern or wording that should be clarified.

Every material risk must include an exact 10-30 word quote and the page number it came from.
Do not report risks for pages with no extractable text. Use only the supplied pages.`;

function fullAnalysisPrompt(): string {
  return `
Analyze the supplied contract pages and return JSON with exactly this schema:
${FULL_ANALYSIS_SCHEMA}

${SEVERITY_GUIDANCE}`;
}

function batchAnalysisPrompt(pages: PdfPage[]): string {
  const text = pages
    .map((page) => buildPageMarkers(page.pageNumber, page.text))
    .join('\n\n');

  return `
Analyze ONLY the supplied pages and return JSON with exactly this schema:
${FULL_ANALYSIS_SCHEMA}

${SEVERITY_GUIDANCE}
Analyze ONLY the supplied pages. Do not reference other pages. Do not infer missing text.
Return risks and key terms reliably; set contractType, parties, overallRiskScore, summary and recommendations to empty/0 values.

Contract pages:
${text}`;
}

const INTERACTION_SCHEMA = `
{
  "risks": [
    {
      "id": "string",
      "text": "verbatim 15-45 word quote drawn from the supplied contract text, including every clause involved",
      "riskLevel": "low|medium|high|critical",
      "category": "string",
      "description": "string explaining the cross-clause conflict, contradiction, or compounding effect",
      "recommendation": "string",
      "pageNumber": 1,
      "relatedPages": [1, 2],
      "searchText": "string of 5-10 searchable words"
    }
  ]
}`;

function interactionPrompt(tail: string, risks: ContractRisk[]): string {
  const existing = risks
    .map(
      (risk) =>
        `- ["${risk.text}", level ${risk.riskLevel}, page ${risk.pageNumber}]`,
    )
    .join('\n');

  return `
You are a senior contract reviewer performing a document-wide cross-clause audit.
Your job is to find risks that are HIDDEN ACROSS MULTIPLE CLAUSES or that arise from the
INTERACTION between separate provisions. These are exactly the risks a page-by-page
review misses.

Return JSON with exactly this schema:
${INTERACTION_SCHEMA}

Types of cross-clause risks to hunt for:
- Contradictions and conflicts between two or more provisions.
- One clause quietly undermining a protection granted elsewhere (e.g. a warranty or
  indemnity that a later exception swallows).
- Provisions that compound: individually benign terms that together create an
  off-market or harmful outcome.
- Broken or misleading cross-references (e.g. "defined in Section 12.3" where the
  section actually says something different, or numbered sections the parties rely on
  but that do not say what they appear to).
- Inconsistent definitions across the document.
- Coverage gaps: protections or rights that break because related clauses are missing
  or conditional.
Do NOT report single-clause issues that appear on one page in isolation; those are
already captured by the extraction pass. Report ONLY risks that require reading two or
more clauses together. Do not re-report a risk already in the list below unless the
interaction produces a materially NEW risk.

Evidence rules:
- Quote VERBATIM from the supplied contract text. Do not paraphrase or combine quotes
  into prose.
- Every risk must give exact page numbers: pageNumber for the primary clause and
  relatedPages for EVERY other page involved.
- If you cannot tie the risk to exact quoted language on real pages, omit it.
- Do not claim to provide legal advice.

Existing risks already identified (do not duplicate unless materially new):
${existing || 'none'}

Contract text (page markers included):
${tail}`;
}

async function findInteractionRisks(
  pages: PdfPage[],
  risks: ContractRisk[],
): Promise<ContractRisk[]> {
  const text = await extractContractText(pages);
  if (text.trim().length === 0 || text.length > INTERACTION_FULL_TEXT_CHAR_LIMIT) {
    return [];
  }

  const raw = await groqJsonRequest(
    JSON_SYSTEM_PROMPT,
    interactionPrompt(text, risks),
    INTERACTION_MAX_TOKENS,
    { reasonEffort: 'high', jsonMode: false },
  );

  if (!isPlainObject(raw) || !Array.isArray(raw.risks)) {
    return [];
  }

  const candidates = (raw.risks as Array<Record<string, unknown>>)
    .filter(isPlainObject)
    .map((candidate) => ({
      id: typeof candidate.id === 'string' ? candidate.id : undefined,
      text:
        typeof candidate.text === 'string' ? candidate.text : 'Clause text unavailable.',
      riskLevel: candidate.riskLevel,
      category: typeof candidate.category === 'string' ? candidate.category : undefined,
      description:
        typeof candidate.description === 'string' ? candidate.description : undefined,
      recommendation:
        typeof candidate.recommendation === 'string'
          ? candidate.recommendation
          : undefined,
      pageNumber: candidate.pageNumber,
      relatedPages: Array.isArray(candidate.relatedPages)
        ? (candidate.relatedPages as unknown[])
        : undefined,
      searchText:
        typeof candidate.searchText === 'string' ? candidate.searchText : undefined,
    }));

  return verifyRisksAgainstPages(
    pages,
    candidates as unknown as Partial<ContractRisk>[],
  );
}

function synthesisPrompt(
  risks: ContractRisk[],
  keyTerms: string[],
  baselineScore: number,
): string {
  return `
You are consolidating an AI contract analysis into a decision brief.

Inputs:
- Deduplicated risks (JSON array): ${JSON.stringify(risks)}
- Key terms (JSON array): ${JSON.stringify(keyTerms)}
- Deterministic baseline risk score: ${baselineScore}

Return JSON with exactly this schema:
{
  "contractType": "string",
  "parties": ["string"],
  "keyTerms": ["string"],
  "overallRiskScore": 0,
  "summary": "string of 2-4 sentences",
  "recommendations": ["string of practical next steps"]
}

Rules:
- Do not invent contract language.
- Prefer the deterministic baseline score when you cannot provide a trustworthy numeric score.
- Overall risk score is an integer 0-100.
- Do not claim to provide legal advice.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function safeSummary(obj: Record<string, unknown>): string {
  return typeof obj.summary === 'string' && obj.summary.trim().length > 0
    ? obj.summary
    : 'Paqt could not generate a summary for this contract.';
}

function safeScore(obj: Record<string, unknown>, baseline: number): number {
  if (typeof obj.overallRiskScore === 'number' && Number.isFinite(obj.overallRiskScore)) {
    const rounded = Math.round(obj.overallRiskScore);
    if (rounded >= 0 && rounded <= 100) {
      return rounded;
    }
  }
  return baseline;
}

async function analyzeSmallDocument(pages: PdfPage[]): Promise<ContractAnalysis> {
  const text = pages.map((page) => buildPageMarkers(page.pageNumber, page.text)).join('\n\n');
  const raw = await groqJsonRequest(
    JSON_SYSTEM_PROMPT,
    fullAnalysisPrompt() + `\n\nContract text:\n${text}`,
  );

  if (!isPlainObject(raw)) {
    throw new GroqServiceError(
      'invalid_json',
      'AI returned an unexpected analysis format. Please retry.',
    );
  }

  const risks = normalizeRisks(
    Array.isArray(raw.risks) ? (raw.risks as Partial<ContractRisk>[]) : [],
  );

  return {
    contractType: typeof raw.contractType === 'string' ? raw.contractType : 'Contract',
    parties: isStringArray(raw.parties) ? raw.parties : [],
    keyTerms: isStringArray(raw.keyTerms) ? raw.keyTerms : [],
    risks,
    overallRiskScore: safeScore(raw, computeRiskScore(risks)),
    summary: safeSummary(raw),
    recommendations: isStringArray(raw.recommendations) ? raw.recommendations : [],
  };
}

async function analyzePageBatch(pages: PdfPage[]): Promise<ContractRisk[]> {
  const raw = await groqJsonRequest(
    JSON_SYSTEM_PROMPT,
    batchAnalysisPrompt(pages),
    BATCH_MAX_TOKENS,
  );

  if (isPlainObject(raw) && Array.isArray(raw.risks)) {
    return normalizeRisks(raw.risks as Partial<ContractRisk>[]);
  }
  return [];
}

async function synthesizeDocument(
  risks: ContractRisk[],
  keyTerms: string[],
  baselineScore: number,
): Promise<ContractAnalysis> {
  const raw = await groqJsonRequest(
    JSON_SYSTEM_PROMPT,
    synthesisPrompt(risks, keyTerms, baselineScore),
  );

  if (!isPlainObject(raw)) {
    throw new GroqServiceError(
      'invalid_json',
      'AI returned an unexpected analysis format. Please retry.',
    );
  }

  return {
    contractType: typeof raw.contractType === 'string' ? raw.contractType : 'Contract',
    parties: isStringArray(raw.parties) ? raw.parties : [],
    keyTerms:
      isStringArray(raw.keyTerms) && raw.keyTerms.length > 0
        ? raw.keyTerms
        : keyTerms,
    risks,
    overallRiskScore: safeScore(raw, baselineScore),
    summary: safeSummary(raw),
    recommendations: isStringArray(raw.recommendations) ? raw.recommendations : [],
  };
}

export type AnalysisProgressCallback = (
  label: string,
  stage: ProgressStage,
  detail?: { from: number; to: number; total: number },
) => void;

export async function analyzePages(
  pages: PdfPage[],
  onProgress?: AnalysisProgressCallback,
): Promise<ContractAnalysis> {
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);

  let baseRisks: ContractRisk[];
  let allKeyTerms: string[] = [];
  let smallDoc: ContractAnalysis | null = null;

  if (pages.length <= SINGLE_CALL_MAX_PAGES && totalChars <= SINGLE_CALL_MAX_CHARS) {
    onProgress?.('Analyzing contract…', 'analyzing');
    smallDoc = await analyzeSmallDocument(pages);
    baseRisks = smallDoc.risks;
    allKeyTerms = smallDoc.keyTerms;
  } else {
    // Large document: batched path.
    onProgress?.('Preparing pages…', 'preparing');
    const batches = groupPagesIntoBatches(pages);
    const allRisks: ContractRisk[] = [];

    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      const firstPage = batch[0]?.pageNumber ?? 1;
      const lastPage = batch[batch.length - 1]?.pageNumber ?? firstPage;
      onProgress?.(
        `Analyzing pages ${firstPage}–${lastPage} of ${pages.length}`,
        'analyzing',
        { from: firstPage, to: lastPage, total: pages.length },
      );
      const risks = await analyzePageBatch(batch);
      allRisks.push(...risks);
    }

    baseRisks = normalizeRisks(allRisks);
  }

  // Document-wide interaction pass: catches risks hidden across clauses or created
  // by clause interactions, which the per-page/batch passes structurally cannot see.
  onProgress?.('Checking how clauses interact…', 'consolidating');
  let interactionRisks: ContractRisk[] = [];
  try {
    const found = await findInteractionRisks(pages, baseRisks);
    interactionRisks = keepVerifiedRisks(found);
  } catch (caught) {
    console.warn('Cross-clause interaction pass skipped:', caught);
  }

  const merged = normalizeRisks([...baseRisks, ...interactionRisks]);

  if (smallDoc) {
    return {
      contractType: smallDoc.contractType,
      parties: smallDoc.parties,
      keyTerms: smallDoc.keyTerms,
      risks: merged,
      overallRiskScore: computeRiskScore(merged),
      summary: smallDoc.summary,
      recommendations: smallDoc.recommendations,
    };
  }

  onProgress?.('Preparing decision brief…', 'synthesizing');
  const baselineScore = computeRiskScore(merged);
  return synthesizeDocument(merged, allKeyTerms, baselineScore);
}

export async function chatWithContract(
  question: string,
  contractText: string,
  analysis: ContractAnalysis,
): Promise<string> {
  const contextText = (contractText || '').slice(0, ANALYSIS_CONTEXT_LIMIT);

  const systemPrompt = [
    'You are Paqt\u2019s contract analysis assistant.',
    'Use the supplied contract context as the source of truth.',
    'When answering:',
    '1. quote relevant clauses.',
    '2. explain them plainly.',
    '3. state practical implications.',
    '4. suggest questions or negotiation points where useful.',
    '5. never fabricate a clause.',
    '6. do not state that you provide legal advice.',
    '7. recommend qualified legal counsel for consequential decisions.',
  ].join('\n');

  const analysisSummary = analysis.risks.length
    ? `\n\nIdentified risks:\n${analysis.risks
        .map(
          (risk) =>
            `- ["${risk.text}", page ${risk.pageNumber}]`,
        )
        .join('\n')}`
    : '';

  const userPrompt = `Contract text (extracted from PDF, page markers included):\n${contextText}\n${analysisSummary}\n\nQuestion:\n${question}`;

  return groqTextRequest(systemPrompt, userPrompt);
}