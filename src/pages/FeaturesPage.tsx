import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  FileDown,
  FilePenLine,
  MessageSquare,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { MarketingNav, MarketingFooter } from '../components/MarketingNav';

const DETAILS = [
  {
    icon: ScanSearch,
    title: 'Review contracts with evidence',
    description:
      'Paqt reads every page of your PDF and returns the clauses worth your attention — not generic prose.',
    bullets: [
      'Text is extracted in your browser — the raw file never leaves the client',
      'Multi-page documents are analyzed page by page so nothing is skimmed',
      'Every finding links to an exact page and quotes the underlying clause',
    ],
  },
  {
    icon: FilePenLine,
    title: 'Compose agreements from a brief',
    description:
      'Describe the deal in plain English and let Paqt produce a structured, legal-style agreement you can edit directly.',
    bullets: [
      'A few targeted clarifying questions before the first draft',
      'Numbered sections, recitals, placeholders, and a signatures block',
      'Ask for a natural-language revision and the whole document updates consistently',
    ],
  },
  {
    icon: MessageSquare,
    title: 'Ask grounded follow-up questions',
    description:
      'The assistant answers with a capped, page-aware excerpt of your document plus the full analysis.',
    bullets: [
      'Answers reference real clauses instead of the whole contract',
      'Page-aware context keeps responses focused and fast',
      'No per-message re-scanning of the full document',
    ],
  },
  {
    icon: RotateCcw,
    title: 'Resume, reopen, and reuse',
    description:
      'Long reviews checkpoint after every analyzed page, so pausing is safe and resuming is instant.',
    bullets: [
      'Paused reviews resume from the last analyzed page',
      'Completed analyses reopen in read-only form without re-running the AI',
      'Up to 40 entries kept in browser history',
    ],
  },
  {
    icon: FileDown,
    title: 'Export a clean legal PDF',
    description:
      'One click downloads a professionally formatted agreement — letter-size layout, section headings, and signature lines.',
    bullets: [
      'Embedded typography for a consistent look on screen and in print',
      'Auto-generated signature area after IN WITNESS WHEREOF',
      'Select “Analyze for risks” to run the draft through the same review pipeline',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Private by design',
    description:
      'Paqt is built around a small, honest data footprint: guest workspace, local history, server-side keys.',
    bullets: [
      'No account or sign-up — the whole workspace is your browser',
      'AI credentials live on the server and never ship to the browser',
      'No database at this stage: nothing is permanently stored',
    ],
  },
];

export function FeaturesPage() {
  return (
    <div className="min-h-[100dvh] bg-background">
      <MarketingNav />

      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_60%_at_50%_-10%,hsl(var(--primary)/0.09),transparent)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:pt-20">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-medium text-primary">Features</p>
            <h1 className="mt-1 text-4xl font-semibold tracking-tight text-foreground">
              Everything Paqt does.
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
              The contract decision layer before you sign — review with evidence, draft with
              direction, and keep complete control of your documents.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" asChild>
                <Link to="/dashboard">
                  Open dashboard
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/">
                  Back to home
                  <ArrowRight className="size-4 rotate-180" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <div className="flex flex-col gap-6">
          {DETAILS.map((detail, index) => (
            <div
              key={detail.title}
              className="grid gap-6 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start"
            >
              <div className="flex items-start gap-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <detail.icon className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {String(index + 1).padStart(2, '0')}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-foreground">{detail.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {detail.description}
                  </p>
                </div>
              </div>
              <ul className="flex flex-col gap-2.5 lg:pt-1">
                {detail.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-start gap-2.5 text-sm text-foreground/80">
                    <Check className="mt-0.5 size-4 shrink-0 text-low-600" aria-hidden="true" />
                    <span className="leading-relaxed">{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-2xl border border-primary/20 bg-primary/5 px-6 py-8 text-center">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Try it on your own contract.
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Open the dashboard, upload a PDF, and see exactly where the risk is — before you sign.
          </p>
          <Button size="lg" asChild className="mt-6">
            <Link to="/dashboard">
              Open dashboard
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}