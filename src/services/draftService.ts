import {
  groqJsonRequest,
  groqTextRequest,
  getReasoningEffort,
  pushGroqOp,
  popGroqOp,
  setGroqRunId,
} from './groqService';
import { createHistoryId } from './historyService';
import { DRAFT_DISCLAIMER_LINE } from '../utils/contractDocument';

const DRAFT_MAX_TOKENS = 16_384;
const MAX_QUESTIONS = 6;

export interface DraftAnswers {
  [questionId: number]: string;
}

const QUESTIONS_SYSTEM_PROMPT = [
  'You are a contract drafting assistant.',
  'Return valid JSON only, matching the exact schema in the request.',
  'Ask only genuinely relevant legal/factual questions that are NOT already answered in the brief.',
  'Never ask about things the brief already states.',
  'Never present the questions as legal advice.',
].join('\n');

const QUESTIONS_SCHEMA = `
Return JSON with exactly this schema:
{
  "questions": ["string", "..."]
}
Each question must target ONE missing detail that meaningfully changes the draft, such as:
- full legal names of the parties,
- governing law / jurisdiction / state or country,
- the specific services or deliverables and acceptance criteria,
- IP ownership and third-party tools involved,
- payment currency, deposit or kill-fee structure,
- confidentiality / non-compete / exclusivity needs,
- term length and termination / renewal expectations.
Ask at most ${MAX_QUESTIONS} questions. Return an empty array if nothing important is missing.`;

const DRAFT_SYSTEM_PROMPT = [
  'You are Paqt\u2019s contract drafting assistant. You turn a plain-language brief into a properly formatted legal contract draft.',
  'Write in clear, plain-English legal language suitable for small businesses and freelancers.',
  'Use the standard legal structure: Title; Parties; Recitals/Background; Services & Deliverables; Fees & Payment; Taxes; Term & Termination; IP & Licensing; Confidentiality; Warranties; Limitation of Liability; Indemnification; Governing Law & Dispute Resolution; Entire Agreement; Key Assumptions; Signatures.',
  'Formatting rules: start with a bold all-caps title line: `# TITLE OF CONTRACT`. Use `## 1. SECTION NAME`, `## 2. SECTION NAME`, etc. for top-level numbered sections. Use `### 1.1` style sub-numbering for sub-sections. Use Markdown ordered/bullet lists with letters for sub-items where useful. Do NOT use tables under any circumstances. Do NOT use code fences.',
  'Recitals: after the title and party line, add an italic "WHEREAS" recitals block using a Markdown blockquote (`> ...`), then a numbered section `## 1. AGREEMENT` recapping the operative agreement in a few lines.',
  'Signatures: finish with a section heading literally named `## SIGNATURES` plus a paragraph beginning with the phrase "IN WITNESS WHEREOF".',
  'Faithfully encode every concrete detail supplied in the brief (amounts, schedule, scope, Net-30 payments, currency, etc.).',
  'Never invent facts. For anything unknown and legally required, insert an explicit placeholder such as [Client Full Legal Name], [Provider Full Legal Name], [State or Country].',
  'Include a "Key assumptions" section listing every assumption you had to make.',
  'Return the contract as clean GitHub-style Markdown with no preamble and no code fences.',
].join('\n');

const REVISE_SYSTEM_PROMPT = [
  'You are Paqt\u2019s contract drafting assistant. You revise an existing draft according to an instruction.',
  'Apply the requested change consistently across the whole document (every place it is relevant).',
  'Keep everything else unchanged, including sections, placeholders, and the "Key assumptions" section (update assumptions if the change affects them).',
  'Keep the numbered-section structure (`## 1. SECTION` / `### 1.1`) and do NOT introduce tables or code fences.',
  'Keep the `## SIGNATURES` section heading and the "IN WITNESS WHEREOF" paragraph.',
  'Keep placeholders like [Client Full Legal Name] where facts are still unknown.',
  'Return the complete revised contract as clean GitHub-style Markdown with no preamble and no code fences.',
].join('\n');

function formatAnswers(answers: DraftAnswers): string {
  const entries = Object.entries(answers)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `${Number(key) + 1}. ${value.trim()}`);
  return entries.length > 0 ? entries.join('\n') : 'None provided \u2014 draft using your own reasonable defaults and list them under Key assumptions.';
}

function stripDraftBoilerplate(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept = lines.filter(
    (line) => line.trim() !== DRAFT_DISCLAIMER_LINE.trim(),
  );
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function askDraftingQuestions(brief: string): Promise<string[]> {
  pushGroqOp('chat');
  try {
    const raw = await groqJsonRequest(
      QUESTIONS_SYSTEM_PROMPT,
      `${QUESTIONS_SCHEMA}\n\nAssignment brief:\n${brief}`,
      2048,
      { reasonEffort: getReasoningEffort() },
    );

    const parsed = raw as { questions?: unknown };
    if (typeof raw !== 'object' || raw === null || !Array.isArray(parsed.questions)) {
      return [];
    }
    const questions = parsed.questions as unknown[];
    return questions
      .filter((question) => typeof question === 'string' && question.trim().length > 0)
      .map((question) => (question as string).trim())
      .slice(0, MAX_QUESTIONS);
  } finally {
    popGroqOp();
  }
}

export async function generateContractDraft(brief: string, answers: DraftAnswers): Promise<string> {
  pushGroqOp('draft');
  const runId = createHistoryId('draft');
  setGroqRunId(runId);
  try {
    const userPrompt = `Assignment brief:\n${brief}\n\nAdditional details:\n${formatAnswers(answers)}`;
    return stripDraftBoilerplate(
      await groqTextRequest(DRAFT_SYSTEM_PROMPT, userPrompt, DRAFT_MAX_TOKENS, 0.4, {
        reasonEffort: getReasoningEffort(),
      }),
    );
  } finally {
    setGroqRunId(null);
    popGroqOp();
  }
}

export async function reviseContractDraft(
  brief: string,
  answers: DraftAnswers,
  currentDraft: string,
  instruction: string,
): Promise<string> {
  pushGroqOp('chat');
  try {
    const userPrompt = [
      `Original assignment brief:\n${brief}`,
      `Additional details:\n${formatAnswers(answers)}`,
      `Current draft:\n${currentDraft}`,
      `Revision instruction:\n${instruction}`,
    ].join('\n\n');
    return stripDraftBoilerplate(
      await groqTextRequest(REVISE_SYSTEM_PROMPT, userPrompt, DRAFT_MAX_TOKENS, 0.4, {
        reasonEffort: getReasoningEffort(),
      }),
    );
  } finally {
    popGroqOp();
  }
}

export type ClauseEditAction = 'rewrite' | 'simplify' | 'strengthen' | 'shorten';

const CLAUSE_EDIT_MAX_TOKENS = 8192;

const CLAUSE_EDIT_SYSTEM_PROMPT = [
  'You are an expert contract drafter performing a targeted edit on part of a draft.',
  'Rewrite ONLY the selected clause. Change nothing outside the selection.',
  'Use the section context only for consistency (party names, currency, governing law, definitions).',
  'Keep placeholders like [Client Full Legal Name] exactly as they are if they appear in the selection.',
  'Keep any numbered labels, capitalization, and list formatting inside the selection consistent.',
  'Return only the replacement text for the selected clause \u2014 no preamble, no explanation, no markdown headers.',
  'Never fabricate facts; keep any unknown facts as placeholders.',
  'Do not provide legal advice or add disclaimers in the output.',
].join('\n');

const CLAUSE_EDIT_INSTRUCTIONS: Record<ClauseEditAction, string> = {
  rewrite:
    'Rewrite this clause so it says the same thing in clearer, more precise legal language while staying consistent with the rest of the document.',
  simplify:
    'Simplify this clause into plainer English while preserving its exact legal meaning.',
  strengthen:
    'Rewrite this clause to be more favorable to the drafting party while remaining reasonable, balanced, and enforceable.',
  shorten:
    'Cut this clause to only the essential terms without changing its legal meaning.',
};

export async function rewriteSelectedClause(
  action: ClauseEditAction,
  selectedText: string,
  sectionContext: string,
): Promise<string> {
  const userPrompt = [
    `${CLAUSE_EDIT_INSTRUCTIONS[action]}`,
    '',
    `Section context:\n${sectionContext || '(none provided)'}`,
    '',
    `Selected clause:\n${selectedText}`,
    '',
    'Return ONLY the replacement text for the selected clause.',
  ].join('\n');
  pushGroqOp('clause');
  try {
    const text = await groqTextRequest(
      CLAUSE_EDIT_SYSTEM_PROMPT,
      userPrompt,
      CLAUSE_EDIT_MAX_TOKENS,
      0.4,
      { reasonEffort: getReasoningEffort() },
    );
    const cleaned = stripDraftBoilerplate(text).trim();
    if (!cleaned) {
      throw new Error('empty-rewrite');
    }
    return cleaned;
  } finally {
    popGroqOp();
  }
}