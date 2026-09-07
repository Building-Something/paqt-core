import { groqJsonRequest, groqTextRequest } from './groqService';

const DRAFT_MAX_TOKENS = 8192;
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
  'You are Paqt\u2019s contract drafting assistant. You turn a plain-language brief into a clear, usable contract draft.',
  'Write in simple, plain-English contract language suitable for small businesses and freelancers.',
  'Use the standard structure: Title; Parties; Recitals/Background; Services & Deliverables; Fees & Payment; Taxes; Term & Termination; IP & Licensing; Confidentiality; Warranties; Limitation of Liability; Indemnification; Insurance (only if the brief implies it); Governing Law & Dispute Resolution; Entire Agreement; Signatures.',
  'Faithfully encode every concrete detail supplied in the brief (amounts, schedule, scope, Net-30 payments, currency, etc.).',
  'Never invent facts. For anything unknown and legally required, insert an explicit placeholder such as [Client Full Legal Name], [Provider Full Legal Name], [State or Country].',
  'Use tables only when they help (for example a payment schedule). Otherwise use short headed sections and bullet lists.',
  'Include a "Key assumptions" section listing every assumption you had to make.',
  'End with the line: "This draft is a starting point, not legal advice. Have qualified counsel review it before signing."',
  'Return the contract as clean GitHub-style Markdown with no preamble and no code fences.',
].join('\n');

const REVISE_SYSTEM_PROMPT = [
  'You are Paqt\u2019s contract drafting assistant. You revise an existing draft according to an instruction.',
  'Apply the requested change consistently across the whole document (every place it is relevant).',
  'Keep everything else unchanged, including sections, placeholders, and the "Key assumptions" section (update assumptions if the change affects them).',
  'Keep placeholders like [Client Full Legal Name] where facts are still unknown.',
  'Keep the final line: "This draft is a starting point, not legal advice. Have qualified counsel review it before signing."',
  'Return the complete revised contract as clean GitHub-style Markdown with no preamble and no code fences.',
].join('\n');

function formatAnswers(answers: DraftAnswers): string {
  const entries = Object.entries(answers)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key, value]) => `${Number(key) + 1}. ${value.trim()}`);
  return entries.length > 0 ? entries.join('\n') : 'None provided \u2014 draft using your own reasonable defaults and list them under Key assumptions.';
}

export async function askDraftingQuestions(brief: string): Promise<string[]> {
  const raw = await groqJsonRequest(
    QUESTIONS_SYSTEM_PROMPT,
    `${QUESTIONS_SCHEMA}\n\nAssignment brief:\n${brief}`,
    2048,
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
}

export async function generateContractDraft(brief: string, answers: DraftAnswers): Promise<string> {
  const userPrompt = `Assignment brief:\n${brief}\n\nAdditional details:\n${formatAnswers(answers)}`;
  return groqTextRequest(DRAFT_SYSTEM_PROMPT, userPrompt, DRAFT_MAX_TOKENS);
}

export async function reviseContractDraft(
  brief: string,
  answers: DraftAnswers,
  currentDraft: string,
  instruction: string,
): Promise<string> {
  const userPrompt = [
    `Original assignment brief:\n${brief}`,
    `Additional details:\n${formatAnswers(answers)}`,
    `Current draft:\n${currentDraft}`,
    `Revision instruction:\n${instruction}`,
  ].join('\n\n');
  return groqTextRequest(REVISE_SYSTEM_PROMPT, userPrompt, DRAFT_MAX_TOKENS);
}