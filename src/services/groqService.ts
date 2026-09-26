import type { ContractAnalysis, ContractRisk, PdfPage, ProgressStage } from '../types';
import {
  ANALYSIS_CONTEXT_LIMIT,
  CLIENT_TOKEN_BUDGET_PER_MINUTE,
  INTERACTION_FULL_TEXT_CHAR_LIMIT,
  INTERACTION_MAX_TOKENS,
  INTERACTION_OVERLAP_PAGES,
  INTERACTION_WINDOW_CHAR_LIMIT,
  MAX_RATE_LIMIT_WAIT_MS,
  PER_PAGE_MAX_TOKENS,
  SINGLE_CALL_MAX_CHARS,
  SINGLE_CALL_MAX_PAGES,
} from '../constants/pipeline';
import { buildPageMarkers } from './pdfService';
import { GroqServiceError } from './errors';
import { TokenPacer } from './tokenPacer';
import { computeRiskScore, normalizeRisks } from '../utils/risks';
import { keepVerifiedRisks, verifyRisksAgainstPages } from '../utils/riskVerify';
import { estimateRequestTokens, extractRetryAfterMs } from '../utils/rateLimit';
import { parseJsonObject } from '../utils/json';
import { supabase } from '../lib/supabase';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const JSON_MAX_TOKENS = 4096;
const CHAT_MAX_TOKENS = 2048;

const pacer = new TokenPacer({ tokensPerMinute: CLIENT_TOKEN_BUDGET_PER_MINUTE });

export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Operation context attached to every Groq request so the server can enforce
 * the account's plan. 'analysis' and 'draft' carry an explicit metering header
 * on every request; the DB books at most one unit per (user, period, op, run
 * id), so only the first request of a run actually charges and each extra page
 * or interaction of the same run is a free deduped repeat. 'chat' and 'clause'
 * require an active plan but never decrement a quota.
 */
export type GroqOp = 'analysis' | 'draft' | 'chat' | 'clause';

const opStack: GroqOp[] = ['chat'];
let groqRunId: string | null = null;

export function pushGroqOp(op: GroqOp): void {
  opStack.push(op);
}

export function popGroqOp(): void {
  if (opStack.length > 1) {
    opStack.pop();
  }
}

/**
 * Sets the idempotency key for the current metered run. Because the server
 * books at most one unit per (user, period, op, run id), a checkpoint resume
 * or a retry that reuses the same id can never double-charge the quota.
 */
export function setGroqRunId(id: string | null): void {
  groqRunId = id;
}

let cachedAccessToken: string | null = null;

async function getGroqAccessToken(): Promise<string | null> {
  if (!supabase) {
    return null;
  }
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? null;
    if (token) {
      cachedAccessToken = token;
    }
    return cachedAccessToken;
  } catch {
    return cachedAccessToken;
  }
}

const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium';

let reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT;

export function setReasoningEffort(effort: ReasoningEffort): void {
  reasoningEffort = effort;
}

export function getReasoningEffort(): ReasoningEffort {
  return reasoningEffort;
}

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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface GroqErrorBody {
  error?: { code?: string; message?: string; retryAfterMs?: unknown };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export type GroqWaitReason = 'pacing' | 'retry';

export interface GroqWaitNotice {
  reason: GroqWaitReason;
  waitMs: number;
}

export type GroqWaitListener = (notice: GroqWaitNotice) => void;

let waitListener: GroqWaitListener | null = null;

export function setGroqWaitListener(listener: GroqWaitListener | null): void {
  waitListener = listener;
}

function notifyWait(notice: GroqWaitNotice): void {
  waitListener?.(notice);
}

function backoffDelay(attempt: number, retryAfterMs?: number): number {
  const waitMs =
    retryAfterMs !== undefined && retryAfterMs > 0
      ? retryAfterMs
      : attempt * BACKOFF_BASE_MS;
  return Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS);
}

async function callGroq(
  payload: GroqCompletionRequest,
  attempt = 1,
): Promise<string> {
  const estimated = estimateRequestTokens(payload);
  if (attempt === 1) {
    const pacedWaitMs = pacer.reserve(estimated);
    if (pacedWaitMs > 0) {
      notifyWait({ reason: 'pacing', waitMs: pacedWaitMs });
      await sleep(pacedWaitMs);
    }
  }

  let response: Response;
  try {
    const op = opStack[opStack.length - 1];
    // Metering is decided server-side from the run id, never from a client
    // flag the browser could clear to skip the meter: the DB books at most one
    // unit per (user, period, op, run id), so every request of a run is safe to
    // send — the first call charges, all later calls of the same run are
    // deduped by the ledger as free repeats. One analysis therefore makes as
    // many Groq calls as it needs (pages, interaction, synthesis) while the
    // monthly quota counts the run itself only once. A request outside a run
    // (no id) is checked against the plan but never billed and never refused.
    const runId = groqRunId;
    const token = await getGroqAccessToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-paqt-op': op,
    };
    if (runId !== null && (op === 'analysis' || op === 'draft')) {
      headers['x-paqt-run-id'] = runId;
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    response = await fetch('/api/groq', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof TypeError && attempt < MAX_ATTEMPTS) {
      const delay = backoffDelay(attempt);
      notifyWait({ reason: 'retry', waitMs: delay });
      await sleep(delay);
      return callGroq(payload, attempt + 1);
    }
    throw new GroqServiceError('network', 'Could not reach Paqt analysis service.');
  }

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

    if (code === 'rate_limited_daily') {
      throw new GroqServiceError(code, message, response.status);
    }

    if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
      const retryAfterMs = extractRetryAfterMs(
        parsed?.error?.retryAfterMs,
        response.headers.get('retry-after'),
      );
      const delay = backoffDelay(attempt, retryAfterMs);
      notifyWait({ reason: 'retry', waitMs: delay });
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

  const actual = parsed.usage?.total_tokens;
  if (typeof actual === 'number' && Number.isFinite(actual) && actual > 0) {
    if (actual > estimated) {
      pacer.charge(actual - estimated);
    } else if (actual < estimated) {
      pacer.refund(estimated - actual);
    }
  }
  return content;
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
    reasoning_effort: options.reasonEffort ?? reasoningEffort,
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
  options?: { reasonEffort?: ReasoningEffort },
): Promise<string> {
  return callGroq({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
    reasoning_effort: options?.reasonEffort ?? reasoningEffort,
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

const PAGE_ANALYSIS_SCHEMA = `
{
  "risks": [
    {
      "id": "string",
      "text": "exact 10-30 word clause quote from this page",
      "riskLevel": "low|medium|high|critical",
      "category": "string",
      "description": "string",
      "recommendation": "string",
      "pageNumber": 1,
      "searchText": "string"
    }
  ],
  "keyTerms": ["string"]
}`;

function pageAnalysisPrompt(page: PdfPage): string {
  return `
Analyze this single contract page and return JSON with exactly this schema:
${PAGE_ANALYSIS_SCHEMA}

${SEVERITY_GUIDANCE}
Analyze ONLY this page. Do not reference other pages. Do not infer missing text.
Report the page number for every risk as ${page.pageNumber}.

Contract page:
${buildPageMarkers(page.pageNumber, page.text)}`;
}

interface PageAnalysisOutcome {
  risks: ContractRisk[];
  keyTerms: string[];
}

async function analyzePage(page: PdfPage): Promise<PageAnalysisOutcome> {
  let raw: unknown;
  try {
    raw = await groqJsonRequest(
      JSON_SYSTEM_PROMPT,
      pageAnalysisPrompt(page),
      PER_PAGE_MAX_TOKENS,
    );
  } catch (caught) {
    console.warn(`Page ${page.pageNumber} analysis skipped:`, caught);
    return { risks: [], keyTerms: [] };
  }

  if (!isPlainObject(raw)) {
    return { risks: [], keyTerms: [] };
  }
  return {
    risks: normalizeRisks(
      Array.isArray(raw.risks) ? (raw.risks as Partial<ContractRisk>[]) : [],
    ),
    keyTerms: isStringArray(raw.keyTerms) ? raw.keyTerms : [],
  };
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

async function runInteractionWindow(
  text: string,
  risks: ContractRisk[],
): Promise<unknown> {
  try {
    return await groqJsonRequest(
      JSON_SYSTEM_PROMPT,
      interactionPrompt(text, risks),
      INTERACTION_MAX_TOKENS,
    );
  } catch {
    return groqJsonRequest(
      JSON_SYSTEM_PROMPT,
      interactionPrompt(text, risks),
      INTERACTION_MAX_TOKENS,
      { jsonMode: false },
    );
  }
}

async function findInteractionRisks(
  pages: PdfPage[],
  risks: ContractRisk[],
): Promise<ContractRisk[]> {
  const windows = buildInteractionWindows(pages);
  if (windows.length === 0) {
    return [];
  }

  const candidates: Array<Record<string, unknown>> = [];
  for (const window of windows) {
    let raw: unknown;
    try {
      raw = await runInteractionWindow(window.text, risks);
    } catch (caught) {
      console.warn('Interaction window skipped:', caught);
      continue;
    }
    if (!isPlainObject(raw) || !Array.isArray(raw.risks)) {
      continue;
    }
    candidates.push(
      ...(raw.risks as Array<Record<string, unknown>>).filter(isPlainObject),
    );
  }

  const mapped = candidates.map((candidate) => ({
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
    mapped as unknown as Partial<ContractRisk>[],
  );
}

export function buildInteractionWindows(
  pages: PdfPage[],
): { pages: PdfPage[]; text: string }[] {
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (totalChars === 0 || totalChars > INTERACTION_FULL_TEXT_CHAR_LIMIT) {
    return [];
  }

  const windows: { pages: PdfPage[]; text: string }[] = [];
  let current: PdfPage[] = [];
  let currentChars = 0;

  for (const page of pages) {
    if (
      current.length > 0 &&
      currentChars + page.text.length > INTERACTION_WINDOW_CHAR_LIMIT
    ) {
      windows.push({ pages: [...current], text: interactionWindowText(current) });
      const overlap = current.slice(-INTERACTION_OVERLAP_PAGES);
      current = overlap;
      currentChars = overlap.reduce((sum, overlapPage) => sum + overlapPage.text.length, 0);
    }
    current.push(page);
    currentChars += page.text.length;
  }

  if (current.length > 0) {
    windows.push({ pages: [...current], text: interactionWindowText(current) });
  }

  return windows;
}

function interactionWindowText(pages: PdfPage[]): string {
  return pages.map((page) => buildPageMarkers(page.pageNumber, page.text)).join('\n\n');
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

function fallbackSynthesis(
  risks: ContractRisk[],
  keyTerms: string[],
  baselineScore: number,
): ContractAnalysis {
  const summary =
    risks.length > 0
      ? `Paqt identified ${risks.length} potential risk${
          risks.length === 1 ? '' : 's'
        } in this contract. The document warrants a closer look before signing.`
      : 'Paqt identified no major risks in this contract.';
  return {
    contractType: 'Contract',
    parties: [],
    keyTerms,
    risks,
    overallRiskScore: baselineScore,
    summary,
    recommendations: [
      'Review the flagged clauses with the other party before signing.',
      'Ask Paqt to explain any risk in more detail.',
      'Probe the worst-case outcome of each flagged clause before signing.',
    ],
  };
}

async function synthesizeDocument(
  risks: ContractRisk[],
  keyTerms: string[],
  baselineScore: number,
): Promise<ContractAnalysis> {
  let raw: unknown;
  try {
    raw = await groqJsonRequest(
      JSON_SYSTEM_PROMPT,
      synthesisPrompt(risks, keyTerms, baselineScore),
    );
  } catch (caught) {
    console.warn('Synthesis fell back to a deterministic brief:', caught);
    return fallbackSynthesis(risks, keyTerms, baselineScore);
  }

  if (!isPlainObject(raw)) {
    return fallbackSynthesis(risks, keyTerms, baselineScore);
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

export interface AnalyzePageProgress {
  from?: number;
  to?: number;
  total?: number;
  risks: ContractRisk[];
  keyTerms?: string[];
  done?: boolean;
}

export type AnalysisProgressCallback = (
  label: string,
  stage: ProgressStage,
  detail?: AnalyzePageProgress,
) => void;

export interface AnalyzePagesOptions {
  /** 0-based index of the first page to analyze; when > 0 the analysis resumes from stored findings. */
  fromIndex?: number;
  existingRisks?: ContractRisk[];
  existingKeyTerms?: string[];
}

export async function analyzePages(
  pages: PdfPage[],
  onProgress?: AnalysisProgressCallback,
  options: AnalyzePagesOptions = {},
): Promise<ContractAnalysis> {
  pushGroqOp('analysis');
  try {
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  const startIndex = options.fromIndex ?? 0;
  const resuming = startIndex > 0;
  const useSingleCall =
    !resuming &&
    pages.length <= SINGLE_CALL_MAX_PAGES &&
    totalChars <= SINGLE_CALL_MAX_CHARS;

  let baseRisks: ContractRisk[];
  let allKeyTerms: string[] = [];
  let smallDoc: ContractAnalysis | null = null;

  if (useSingleCall) {
    onProgress?.('Analyzing contract…', 'analyzing');
    smallDoc = await analyzeSmallDocument(pages);
    baseRisks = smallDoc.risks;
    allKeyTerms = smallDoc.keyTerms;
  } else {
    // Per-page streaming: every page is analyzed individually and in order so
    // larger documents get focused attention, findings accumulate live, and the
    // analysis can be resumed from a checkpoint instead of restarting.
    onProgress?.(
      resuming
        ? `Resuming from page ${startIndex + 1} of ${pages.length}…`
        : 'Preparing pages…',
      'preparing',
    );

    const allRisks: ContractRisk[] = [...(options.existingRisks ?? [])];
    allKeyTerms = [...(options.existingKeyTerms ?? [])];
    const total = pages.length;

    for (let i = startIndex; i < total; i += 1) {
      const page = pages[i];
      const current = i + 1;
      onProgress?.(`Analyzing page ${current} of ${total}…`, 'analyzing', {
        from: current,
        to: current,
        total,
        risks: normalizeRisks(allRisks),
        keyTerms: allKeyTerms,
      });
      const outcome = await analyzePage(page);
      allRisks.push(...outcome.risks);
      allKeyTerms.push(...outcome.keyTerms);
      const accumulated = normalizeRisks(allRisks);
      onProgress?.(
        `Analyzed page ${current} · ${accumulated.length} finding${
          accumulated.length === 1 ? '' : 's'
        } so far`,
        'analyzing',
        {
          from: current,
          to: current,
          total,
          risks: accumulated,
          keyTerms: allKeyTerms,
          done: true,
        },
      );
    }

    baseRisks = normalizeRisks(allRisks);
  }

  // Document-wide interaction pass: catches risks hidden across clauses or created
  // by clause interactions, which the per-page passes structurally cannot see.
  onProgress?.('Checking how clauses interact…', 'consolidating', { risks: baseRisks });
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

  onProgress?.('Preparing decision brief…', 'synthesizing', { risks: merged });
  const baselineScore = computeRiskScore(merged);
  return synthesizeDocument(merged, allKeyTerms, baselineScore);
  } finally {
    popGroqOp();
  }
}

export async function chatWithContract(
  question: string,
  contractText: string,
  analysis: ContractAnalysis,
  options: { pages?: PdfPage[] } = {},
): Promise<string> {
  const contextText = buildChatContext(question, contractText, options.pages);

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

  pushGroqOp('chat');
  try {
    return groqTextRequest(systemPrompt, userPrompt);
  } finally {
    popGroqOp();
  }
}

function buildChatContext(
  question: string,
  contractText: string,
  pages?: PdfPage[],
): string {
  if (!contractText) {
    return '';
  }
  const pageMatch = question.match(/\b(?:page|section)\s+(\d+)\b/i);
  if (pageMatch && pages) {
    const target = Number(pageMatch[1]);
    const hit = pages.find((page) => page.pageNumber === target);
    if (hit && hit.text.trim().length > 0) {
      const index = pages.indexOf(hit);
      const parts = [hit];
      if (index > 0) {
        parts.unshift(pages[index - 1]);
      }
      if (index < pages.length - 1) {
        parts.push(pages[index + 1]);
      }
      return parts
        .map((page) => buildPageMarkers(page.pageNumber, page.text))
        .join('\n\n')
        .slice(0, ANALYSIS_CONTEXT_LIMIT);
    }
  }
  return (contractText || '').slice(0, ANALYSIS_CONTEXT_LIMIT);
}