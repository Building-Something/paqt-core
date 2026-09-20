import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  FileDown,
  FilePenLine,
  FileText,
  MessageSquare,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { MarketingNav, MarketingFooter } from '../components/MarketingNav';
import { useAuth } from '../contexts/AuthContext';

const FEATURES = [
  {
    icon: ScanSearch,
    title: 'Review contracts',
    description:
      'Upload a PDF and Paqt finds the clauses that deserve your attention — every finding linked to an exact page and quoted clause.',
  },
  {
    icon: FilePenLine,
    title: 'Draft agreements',
    description:
      'Describe the deal in plain English. Paqt asks a few clarifying questions and composes a structured, legal-style agreement.',
  },
  {
    icon: MessageSquare,
    title: 'Ask follow-ups',
    description:
      'The assistant answers with the real clauses in your document as context, so follow-up questions stay grounded in the contract.',
  },
  {
    icon: FileDown,
    title: 'Export a clean PDF',
    description:
      'One click turns a drafted agreement into a professionally formatted legal PDF, with signature blocks ready to go.',
  },
  {
    icon: RotateCcw,
    title: 'Resume anytime',
    description:
      'Long reviews resume from the last analyzed page. Completed results reopen instantly — no AI re-run needed.',
  },
  {
    icon: ShieldCheck,
    title: 'Built to stay lean',
    description:
      'PDFs are extracted in your browser and analyzed through Paqt’s server proxy. Account history stores compact summaries and small previews, not raw files — so storage stays flat across thousands of reviews.',
  },
];

const STEPS = [
  {
    number: '01',
    title: 'Upload a document',
    description:
      'Drop in a PDF — NDAs, MSAs, vendor agreements, anything. Text is extracted in your browser, page by page.',
  },
  {
    number: '02',
    title: 'Review the findings',
    description:
      'Paqt scores the document, flags risks by severity, and pins each finding to the page and quote behind it.',
  },
  {
    number: '03',
    title: 'Decide with evidence',
    description:
      'Open any finding in context, ask the assistant follow-up questions, and act — or send the agreement through the same review.',
  },
];

const USE_CASES = [
  {
    label: 'Sales & procurement',
    detail: 'Fast reviews of inbound MSAs, NDAs, and statements of work — before they sit in your inbox for a week.',
  },
  {
    label: 'Finance teams',
    detail: 'Vendor and service agreements checked consistently, so negotiated terms don’t get silently re-introduced.',
  },
  {
    label: 'Founders',
    detail: 'Pre-signature checks and composed agreements for partnership and customer documents, without a full legal review.',
  },
];

const FAQS = [
  {
    question: 'Does Paqt replace a lawyer?',
    answer:
      'No. Paqt is decision-support software. It flags clauses worth attention and explains them plainly, but you should verify every finding against your document and get qualified legal advice before material decisions.',
  },
  {
    question: 'Is my document uploaded anywhere?',
    answer:
      'Extraction happens entirely in your browser. The extracted text is analyzed through Paqt’s server proxy to the AI provider. We never store the original PDF — your account history keeps a compact summary of each review plus a small page preview.',
  },
  {
    question: 'Can I reopen an analysis without re-running the AI?',
    answer:
      'Yes. Completed analyses are saved to your account and reopen instantly — findings, quotes, scores, and a page preview included.',
  },
  {
    question: 'What do I need to get started?',
    answer:
      'Create a free account, then open your workspace. Analysis features also need a GROQ_API_KEY configured on the server side (set in .env) — the key never ships to the browser.',
  },
];

function AppPreview() {
  const stats = [
    { label: 'Contracts reviewed', value: '24' },
    { label: 'Risks flagged', value: '137' },
    { label: 'Avg. risk score', value: '42' },
  ];
  const rows = [
    { name: 'Master Services Agreement.pdf', meta: '18 pages · 9 risks', score: '66', tone: 'bg-critical-500' },
    { name: 'Mutual NDA – Vendor.pdf', meta: '6 pages · 2 risks', score: '18', tone: 'bg-low-500' },
    { name: 'SaaS Subscription Agreement.pdf', meta: '11 pages · 5 risks', score: '47', tone: 'bg-high-500' },
  ];

  return (
    <div className="mx-auto mt-14 max-w-4xl overflow-hidden rounded-2xl border border-border bg-card shadow-pop">
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-4 py-3">
        <span className="size-2.5 rounded-full bg-critical-500/60" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-medium-500/60" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-low-500/60" aria-hidden="true" />
        <div className="ml-3 h-5 w-44 rounded-md bg-muted" aria-hidden="true" />
      </div>
      <div className="grid grid-cols-3 gap-px bg-border sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-card p-4 sm:p-5">
            <div className="h-2 w-16 rounded-sm bg-muted" aria-hidden="true" />
            <p className="mt-2 text-xl font-semibold tabular-nums tracking-tight text-foreground sm:text-2xl">
              {stat.value}
            </p>
            <p className="text-[11px] text-muted-foreground sm:text-xs">{stat.label}</p>
          </div>
        ))}
      </div>
      <div className="space-y-2 border-t border-border bg-card p-4 sm:p-5">
        {rows.map((row) => (
          <div
            key={row.name}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
              <p className="text-xs text-muted-foreground">{row.meta}</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white ${row.tone}`}>
              {row.score}/100
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LandingPage() {
  const { session } = useAuth();
  const signedIn = Boolean(session);
  const primaryTarget = signedIn ? '/dashboard' : '/signup';

  return (
    <div className="min-h-[100dvh] bg-background">
      <MarketingNav />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_60%_at_50%_-10%,hsl(var(--primary)/0.09),transparent)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-20">
          <div className="mx-auto max-w-3xl text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              <span className="relative flex size-2" aria-hidden="true">
                <span className="absolute inline-flex size-full rounded-full bg-low-500 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-low-500" />
              </span>
              AI contract review & drafting workspace
            </p>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Know what you&rsquo;re signing.
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Paqt reviews the contracts you receive, flags the clauses that deserve your
              attention, and drafts the agreements you send — every finding tied to the exact page
              and quote.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" asChild>
                <Link to={primaryTarget}>
                  {signedIn ? 'Open dashboard' : 'Get started for free'}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/features">Explore features</Link>
              </Button>
            </div>
            <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <li className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-low-600" aria-hidden="true" />
                Free account, works across devices
              </li>
              <li className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-low-600" aria-hidden="true" />
                PDFs extracted in your browser
              </li>
              <li className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-low-600" aria-hidden="true" />
                Reopen results instantly
              </li>
            </ul>

            {/* Trust line */}
            <p className="mx-auto mt-8 inline-flex max-w-xl items-center justify-center gap-2 rounded-full border border-border bg-background/80 px-4 py-2 text-center text-xs text-muted-foreground shadow-sm backdrop-blur">
              <ShieldCheck className="size-3.5 shrink-0 text-low-600" aria-hidden="true" />
              Your contract or PDF stays safe with Paqt — encrypted in transit, saved to your
              private account, and never sold or shared.
            </p>
          </div>
          <AppPreview />
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border bg-card/50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-primary">Features</p>
            <h2 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
              A workspace, not another sign-off tool.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Review, draft, and decide in one place — designed around the idea that every
              finding should be inspectable, not just summarized.
            </p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/30"
              >
                <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <feature.icon className="size-4" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-primary">How it works</p>
          <h2 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            Three steps from upload to decision.
          </h2>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.number} className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <span className="text-xs font-semibold tracking-[0.2em] text-primary">
                {step.number}
              </span>
              <h3 className="mt-3 text-base font-semibold text-foreground">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {step.description}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-10 grid gap-4 rounded-2xl border border-border bg-card p-6 sm:p-8 md:grid-cols-3">
          {USE_CASES.map((useCase, index) => (
            <div key={useCase.label} className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                {String(index + 1).padStart(2, '0')} · {useCase.label}
              </p>
              <p className="text-sm leading-relaxed text-foreground/80">{useCase.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-border bg-card/50">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            Frequently asked questions
          </h2>
          <div className="mt-8 flex flex-col gap-3">
            {FAQS.map((faq) => (
              <details
                key={faq.question}
                className="group rounded-xl border border-border bg-card px-5 py-4 shadow-sm open:bg-card"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                  {faq.question}
                  <span className="text-xs text-muted-foreground transition-transform group-open:rotate-90">
                    →
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-8 text-center sm:p-12">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Start with one contract.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Create a free account, no credit card. Open your workspace and upload your first
            document — or compose an agreement from a plain-English brief.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link to={primaryTarget}>
                {signedIn ? 'Open dashboard' : 'Create a free account'}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to="/features">See all features</Link>
            </Button>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}