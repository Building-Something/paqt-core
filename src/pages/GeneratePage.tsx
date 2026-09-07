import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  FileDown,
  FilePenLine,
  Loader2,
  RefreshCcw,
  ScanSearch,
  Send,
  Sparkles,
} from 'lucide-react';
import { askDraftingQuestions, generateContractDraft, reviseContractDraft } from '../services/draftService';
import { splitDraftIntoSections } from '../utils/draft';
import { exportContractPdf } from '../services/pdfExportService';
import { groqErrorMessage } from '../utils/risks';
import { useAnalysis } from '../contexts/AnalysisContext';
import { Disclaimer } from '../components/Disclaimer';
import {
  type ContractDocNode,
  EMPTY_DOCUMENT,
  docContainsSignatures,
  docToMarkdown,
  markdownToDoc,
} from '../utils/contractDocument';
import { createHistoryId, getHistoryEntry, upsertHistoryEntry } from '../services/historyService';
import { Button } from '../components/ui/button';

const ContractEditor = lazy(() =>
  import('../components/ContractEditor').then((module) => ({ default: module.ContractEditor })),
);

const EXAMPLES = [
  'Create a $5,000 freelance developer contract for building a landing page over 4 weeks, net-30 payment schedule, client owns the final code.',
  'Monthly retainer agreement for social media management, 10 hours per week, $800 per month paid in advance, 90-day notice to cancel.',
  'One-off logo design for $1,500, 50% deposit, delivery in 2 weeks, client owns the files after final payment.',
];

type Phase = 'brief' | 'questions' | 'draft';

function draftSlug(brief: string): string {
  const words = brief
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return `${words || 'contract'}-draft`;
}

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: string }).code === 'string'
  ) {
    const code = (error as { code: string }).code;
    if (code in groqErrorMessage) {
      return groqErrorMessage(code as keyof typeof groqErrorMessage);
    }
  }
  return 'Something went wrong while drafting. Please try again.';
}

function SignaturePreview() {
  const fields = (label: string) => (
    <div className="space-y-6">
      <p className="text-sm font-medium tracking-wide text-foreground">{label}</p>
      {['By:', 'Name:', 'Title:', 'Date:'].map((field) => (
        <div key={field}>
          <p className="text-xs text-muted-foreground">{field}</p>
          <div className="mt-1 border-b border-dotted border-muted-foreground/40" />
        </div>
      ))}
    </div>
  );
  return (
    <div className="px-6 py-10 sm:px-10">
      <div className="border-t border-border pt-8 text-foreground">
        <p className="text-sm text-muted-foreground">
          Signature lines are rendered automatically in the PDF export.
        </p>
      </div>
      <div className="mt-10 grid grid-cols-2 gap-12">
        {fields('CLIENT')}
        {fields('PROVIDER')}
      </div>
    </div>
  );
}

export function GeneratePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { beginWithText } = useAnalysis();

  const [phase, setPhase] = useState<Phase>('brief');
  const [brief, setBrief] = useState('');
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [doc, setDoc] = useState<ContractDocNode>(EMPTY_DOCUMENT);
  const [contentKey, setContentKey] = useState(0);
  const [revision, setRevision] = useState('');
  const [working, setWorking] = useState(false);
  const [busyMessage, setBusyMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const persistTimer = useRef<number | null>(null);

  const markdown = useMemo(() => docToMarkdown(doc), [doc]);
  const hasSignatures = useMemo(() => docContainsSignatures(doc), [doc]);
  const sectionCount = useMemo(() => (markdown ? splitDraftIntoSections(markdown).length : 0), [markdown]);

  useEffect(() => {
    const id = searchParams.get('draft');
    if (!id) {
      return;
    }
    const entry = getHistoryEntry(id);
    if (!entry || entry.kind !== 'draft') {
      return;
    }
    const loadedDoc = entry.draftDoc
      ? (JSON.parse(entry.draftDoc) as ContractDocNode)
      : markdownToDoc(entry.draftMarkdown ?? '');
    draftIdRef.current = id;
    setBrief(entry.draftBrief ?? entry.name);
    setDoc(loadedDoc);
    setContentKey((current) => current + 1);
    setPhase('draft');
    setError(null);
  }, [searchParams]);

function draftEntryIdOrCreate(): string {
  if (!draftIdRef.current) {
    draftIdRef.current = createHistoryId('draft');
  }
  return draftIdRef.current;
}

const persistDraft = useCallback(
  (text: string, docJson: string) => {
    upsertHistoryEntry({
      id: draftEntryIdOrCreate(),
      kind: 'draft',
      name: draftSlug(brief),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      draftBrief: brief,
      draftMarkdown: text,
      draftDoc: docJson,
      sectionCount: splitDraftIntoSections(text).length,
    });
  },
  [brief],
);

  useEffect(() => {
    if (phase !== 'draft' || !markdown.trim()) {
      return;
    }
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      persistDraft(markdown, JSON.stringify(doc));
    }, 800);
    return () => {
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
      }
    };
  }, [persistDraft, markdown, doc, phase, brief]);

  function applyDraft(text: string) {
    setDoc(markdownToDoc(text));
    setContentKey((current) => current + 1);
    persistDraft(text, JSON.stringify(markdownToDoc(text)));
  }

  function resetToBrief() {
    draftIdRef.current = null;
    setPhase('brief');
    setQuestions([]);
    setAnswers({});
    setDoc(EMPTY_DOCUMENT);
    setRevision('');
    setError(null);
    setWorking(false);
  }

  async function runCreate(suppliedAnswers: Record<number, string>) {
    setWorking(true);
    setBusyMessage('Drafting your agreement…');
    setError(null);
    try {
      const text = await generateContractDraft(brief, suppliedAnswers);
      if (!text.trim()) {
        throw new Error('empty-draft');
      }
      applyDraft(text);
      setPhase('draft');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  async function handleStart() {
    const trimmed = brief.trim();
    if (!trimmed || working) {
      return;
    }
    setWorking(true);
    setBusyMessage('Asking a few targeted questions…');
    setError(null);
    try {
      const asked = await askDraftingQuestions(trimmed);
      if (asked.length === 0) {
        await runCreate({});
        return;
      }
      setQuestions(asked);
      setAnswers({});
      setPhase('questions');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  async function handleRevise() {
    const instruction = revision.trim();
    if (!instruction || working || !markdown.trim()) {
      return;
    }
    setWorking(true);
    setBusyMessage('Revising the agreement…');
    setError(null);
    try {
      const text = await reviseContractDraft(brief, answers, markdown, instruction);
      applyDraft(text);
      setRevision('');
      window.scrollTo({ top: 250, behavior: 'smooth' });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  }

  async function handleAnalyze() {
    if (!markdown.trim() || working) {
      return;
    }
    navigate('/analysis');
    void beginWithText(`${draftSlug(brief)} (generated)`, markdown);
  }

  async function handleExportPdf() {
    if (!markdown.trim() || working) {
      return;
    }
    setWorking(true);
    setBusyMessage('Preparing your PDF…');
    setError(null);
    try {
      await exportContractPdf(doc, { fileName: draftSlug(brief) });
    } catch (caught) {
      setError('The PDF could not be generated. Please try again.');
      console.error('PDF export failed', caught);
    } finally {
      setWorking(false);
    }
  }

  const questionCount = questions.length;

  const steps = [
    { key: 'brief', label: 'Describe the deal in plain English' },
    { key: 'questions', label: 'Answer a few targeted details' },
    { key: 'draft', label: 'Edit inline, revise, and export as PDF' },
  ] as const;

  function stepStatus(index: number): 'done' | 'current' | 'pending' {
    const order: Phase[] = ['brief', 'questions', 'draft'];
    const currentIndex = order.indexOf(phase);
    if (index < currentIndex) {
      return 'done';
    }
    if (index === currentIndex) {
      return 'current';
    }
    return 'pending';
  }

  return (
    <div
      className={
        phase === 'draft'
          ? 'mt-4 w-full px-3 sm:px-4'
          : 'mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14'
      }
    >
      <div className="text-center">
        {phase !== 'draft' ? (
          <>
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
              Agentic contract drafting
            </p>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Draft an agreement in plain English
            </h1>
            <p className="mx-auto mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
              Describe what you need and Paqt will ask a few targeted questions,
              then draft a properly formatted contract you can edit inline like
              a word processor, export as a PDF, and analyze for risks.
            </p>
          </>
        ) : null}
      </div>

      <div
      className={
        phase === 'draft'
          ? 'mt-4 grid h-[calc(100vh-6rem)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]'
          : 'mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-start'
      }
    >
        {/* Composer column */}
        <div
          className={
            phase === 'draft'
              ? 'order-2 min-w-0 lg:h-full lg:overflow-y-auto lg:pr-1'
              : 'flex min-w-0 flex-col gap-6 order-2 lg:sticky lg:top-4'
          }
        >
          {error ? (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">{error}</p>
              <button
                type="button"
                onClick={() => setError(null)}
                className="shrink-0 text-xs font-medium text-destructive hover:underline"
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {phase === 'brief' ? (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <label htmlFor="brief" className="block text-sm font-medium text-foreground">
                What kind of agreement do you need?
              </label>
              <div className="relative mt-3">
                <textarea
                  id="brief"
                  rows={5}
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  disabled={working}
                  placeholder='e.g. "Create a $5,000 freelance developer contract for building a landing page over 4 weeks, net-30 payment schedule, client owns the final code."'
                  className="w-full resize-y rounded-md border border-input bg-background px-4 py-3 text-sm leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!brief.trim() || working}
                  className="absolute bottom-3 right-3 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {working ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="size-4" aria-hidden="true" />
                  )}
                  {working ? 'Working…' : 'Start drafting'}
                </button>
              </div>
              {working ? (
                <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                  {busyMessage}
                </p>
              ) : null}

              <div className="mt-5 border-t border-border pt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Try an example
                </p>
                <div className="mt-3 space-y-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setBrief(example)}
                      className="block w-full rounded-md border border-border bg-background px-4 py-2.5 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {phase === 'questions' ? (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-muted p-2 text-primary">
                  <FilePenLine className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {questionCount > 0
                      ? 'A few details will make this much better'
                      : 'Drafting'}{' '}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Answer what you know, or draft now and let Paqt list its assumptions.
                  </p>
                </div>
              </div>

              {questionCount > 0 ? (
                <div className="mt-6 space-y-4">
                  {questions.map((question, index) => (
                    <div key={`${question}-${index + 1}`}>
                      <label
                        htmlFor={`question-${index + 1}`}
                        className="text-sm font-medium text-foreground"
                      >
                        {index + 1}. {question}
                      </label>
                      <input
                        id={`question-${index + 1}`}
                        type="text"
                        value={answers[index] ?? ''}
                        disabled={working}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [index]: event.target.value,
                          }))
                        }
                        placeholder="I don't know yet"
                        className="mt-2 w-full rounded-md border border-input bg-background px-4 py-2.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60"
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button onClick={() => runCreate(answers)} disabled={working}>
                  {working ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="size-4" aria-hidden="true" />
                  )}
                  Draft the agreement
                </Button>
                {questionCount > 0 ? (
                  <Button variant="secondary" onClick={() => runCreate({})} disabled={working}>
                    Skip — draft with assumptions
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={resetToBrief} disabled={working}>
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Edit the brief
                </Button>
              </div>
              {working ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                  {busyMessage}
                </p>
              ) : null}
            </div>
          ) : null}

          {phase === 'draft' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Your draft is ready
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {sectionCount} section{sectionCount === 1 ? '' : 's'} ·
                    edit inline, then export or analyze. Every change is saved
                    to history automatically.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" onClick={handleExportPdf} disabled={working || !markdown.trim()}>
                    {working && busyMessage.startsWith('Preparing') ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <FileDown className="size-4" aria-hidden="true" />
                    )}
                    Export PDF
                  </Button>
                  <Button onClick={handleAnalyze} disabled={working}>
                    <ScanSearch className="size-4" aria-hidden="true" />
                    Analyze for risks
                  </Button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
                <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <RefreshCcw className="size-4 text-primary" aria-hidden="true" />
                  Ask for a change
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Tell Paqt what to alter — payment terms, IP ownership, liability
                  caps, an added clause — and the whole draft is updated
                  consistently.
                </p>
                <textarea
                  id="revision"
                  rows={3}
                  value={revision}
                  disabled={working}
                  onChange={(event) => setRevision(event.target.value)}
                  placeholder='e.g. "Change Net-30 to a 25% deposit and Net-45 balance, and add a non-compete for 6 months."'
                  className="mt-4 w-full resize-y rounded-md border border-input bg-background px-4 py-3 text-sm leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-60"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <Button onClick={handleRevise} disabled={!revision.trim() || working}>
                    {working ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCcw className="size-4" aria-hidden="true" />
                    )}
                    Revise draft
                  </Button>
                  {working ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                      {busyMessage}
                    </p>
                  ) : null}
                </div>
              </div>

              <Button variant="ghost" className="w-full" onClick={resetToBrief}>
                <ArrowLeft className="size-4" aria-hidden="true" />
                Start a new brief
              </Button>
            </>
          ) : null}
        </div>

        {/* Preview / editor column */}
        <div className={phase === 'draft' ? 'order-1 min-w-0 lg:h-full' : 'min-w-0 order-1 lg:sticky lg:top-4'}>
          {phase === 'draft' ? (
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <Suspense
                fallback={
                  <div className="flex h-96 items-center justify-center">
                    <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
                  </div>
                }
              >
                <ContractEditor doc={doc} contentKey={contentKey} onChange={setDoc} />
              </Suspense>
              {hasSignatures ? <SignaturePreview /> : null}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-8 shadow-sm">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="rounded-full bg-muted p-3 text-primary">
                  <FilePenLine className="size-6" aria-hidden="true" />
                </div>
                <h2 className="text-lg font-semibold text-foreground">
                  Your agreement will appear here
                </h2>
                <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                  Paqt drafts the agreement side by side as you work through
                  the steps, ready for direct editing.
                </p>
              </div>
              <ol className="mt-8 space-y-3">
                {steps.map((step, index) => {
                  const status = stepStatus(index);
                  return (
                    <li key={step.key} className="flex items-center gap-3">
                      <span
                        className={[
                          'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          status === 'done'
                            ? 'bg-primary text-primary-foreground'
                            : status === 'current'
                              ? 'border-2 border-primary bg-background text-primary'
                              : 'bg-muted text-muted-foreground',
                        ].join(' ')}
                        aria-hidden="true"
                      >
                        {status === 'done' ? (
                          <Check className="size-3.5" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <span
                        className={[
                          'text-sm',
                          status === 'pending'
                            ? 'text-muted-foreground/70'
                            : 'font-medium text-foreground',
                        ].join(' ')}
                      >
                        {step.label}
                      </span>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-8 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground/90">
                When the draft is ready, follow-up changes are applied to the
                whole document — not find-and-replace — and you can export a
                professionally formatted PDF.
              </div>
            </div>
          )}
        </div>
      </div>

      {phase !== 'draft' ? (
        <div className="mt-10">
          <Disclaimer />
        </div>
      ) : null}
    </div>
  );
}