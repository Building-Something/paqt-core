import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  FileText,
  MessageSquareText,
  PenLine,
  ScanSearch,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Zap,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { MarketingNav, MarketingFooter } from '../components/MarketingNav';
import { Reveal } from '../components/Reveal';
import { useAuth } from '../contexts/AuthContext';

const FEATURES = [
  {
    icon: FileText,
    title: 'Draft any contract from a blank page to sign-ready.',
    description:
      'Pick from 50+ expertly built templates or describe what you need in plain language. Paqt assembles the clauses, fills the parties, and delivers a polished draft in under a minute.',
    feature: true,
  },
  {
    icon: PenLine,
    title: 'Describe your needs',
    description: 'Parties, terms, obligations. Add them in plain English.',
  },
  {
    icon: Send,
    title: 'Send to sign',
    description: 'Finalize and dispatch for secure e-signature in one click.',
  },
  {
    icon: ScanSearch,
    title: 'Understand any contract in seconds, not days.',
    description:
      'Upload a PDF, paste a link, or drop an agreement straight from your inbox. Paqt scans the full document, flags the clauses that matter, and explains them in plain language.',
    feature: true,
  },
  {
    icon: Upload,
    title: 'Upload an agreement',
    description: 'Drag, drop, or paste a URL. We read the whole thing.',
  },
  {
    icon: MessageSquareText,
    title: 'Ask your Contracting Copilot',
    description: 'Chat for clause-level answers and request revisions.',
  },
];

const STEPS = [
  {
    number: '01',
    title: 'Create',
    description:
      'Start from a template or describe the deal in plain language. Paqt drafts the full agreement.',
  },
  {
    number: '02',
    title: 'Review',
    description:
      'Upload or paste any contract. Risks, missing clauses, and obligations surface instantly.',
  },
  {
    number: '03',
    title: 'Refine',
    description:
      'Chat with your Contracting Copilot about any clause. Request changes and get them applied in one click.',
  },
  {
    number: '04',
    title: 'Sign & store',
    description:
      'Finalize with secure e-signature and keep everything organized in a searchable workspace.',
  },
];

const USE_CASES = [
  {
    label: 'Sales & procurement',
    detail:
      'Fast reviews of inbound MSAs, NDAs, and statements of work before they sit in your inbox for a week.',
  },
  {
    label: 'Finance teams',
    detail:
      "Vendor and service agreements checked consistently, so negotiated terms don't get silently re-introduced.",
  },
  {
    label: 'Founders',
    detail:
      'Pre-signature checks and composed agreements for partnership and customer documents, without a full legal review.',
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
      'Your document is read on your device and the text is analyzed privately through Paqt. We never store the original PDF, your account history keeps a compact summary of each review plus a small page preview.',
  },
  {
    question: 'Can I reopen an analysis without re-running the AI?',
    answer:
      'Yes. Completed analyses are saved to your account and reopen instantly, with findings, quotes, scores, and a page preview included.',
  },
  {
    question: 'What do I need to get started?',
    answer:
      'Open your workspace and upload your first document, or compose an agreement from a plain-English brief.',
  },
];

function AppPreview() {
  const stats = [
    { label: 'Contracts reviewed', value: '24', meta: '+3 this week' },
    { label: 'Risks flagged', value: '137', meta: '12 critical' },
    { label: 'Avg. risk score', value: '42', meta: '↓ 9 vs baseline' },
  ];
  const rows = [
    { name: 'Master Services Agreement.pdf', meta: '18 pages · 9 risks', score: '66', tone: 'bg-critical-500', width: 'w-[62%]' },
    { name: 'Mutual NDA – Vendor.pdf', meta: '6 pages · 2 risks', score: '18', tone: 'bg-low-500', width: 'w-[18%]' },
    { name: 'SaaS Subscription Agreement.pdf', meta: '11 pages · 5 risks', score: '47', tone: 'bg-high-500', width: 'w-[41%]' },
  ];
  const bars = [58, 72, 44, 88, 62, 96, 70, 55, 81];

  return (
    <div className="relative mx-auto w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_70px_-20px_hsl(var(--primary)/0.35)] sm:mx-0">
      <div className="crm-scan" aria-hidden="true" />

      {/* Window chrome */}
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-4 py-3">
        <span className="size-2.5 rounded-full bg-critical-500/60" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-medium-500/60" aria-hidden="true" />
        <span className="size-2.5 rounded-full bg-low-500/60" aria-hidden="true" />
        <div className="ml-3 hidden h-5 w-44 items-center gap-2 rounded-md bg-muted px-2 text-[10px] text-muted-foreground sm:flex">
          <Search className="size-3" aria-hidden="true" />
          app.paqt.ai/review
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-low-500/30 bg-low-500/10 px-2 py-0.5 text-[10px] font-semibold text-low-600 dark:text-low-500">
          <span className="live-dot size-1.5 rounded-full bg-low-500" aria-hidden="true" />
          Live analysis
        </span>
      </div>

      {/* Sidebar + main grid to echo the workspace layout */}
      <div className="flex">
        {/* Mini rail */}
        <div className="hidden w-14 flex-col items-center gap-3 border-r border-border bg-card py-4 sm:flex">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <span className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/60">
            <Activity className="size-4" aria-hidden="true" />
          </span>
          <span className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/60">
            <BarChart3 className="size-4" aria-hidden="true" />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          {/* Stats */}
          <div className="grid grid-cols-3 gap-px bg-border">
            {stats.map((stat) => (
              <div key={stat.label} className="bg-card p-3.5 sm:p-4">
                <p className="text-lg font-semibold tabular-nums tracking-tight text-foreground sm:text-xl">
                  {stat.value}
                </p>
                <p className="text-[10px] text-muted-foreground sm:text-[11px]">{stat.label}</p>
                <p className="mt-1 text-[9px] font-medium text-primary sm:text-[10px]">{stat.meta}</p>
              </div>
            ))}
          </div>

          {/* Risk bars + sparkline */}
          <div className="border-t border-border bg-card p-3.5 sm:p-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold text-foreground sm:text-xs">Risk signal by page</p>
              <span className="text-[10px] text-muted-foreground">rolling 9 pages</span>
            </div>
            <div className="mt-2 flex h-14 items-end gap-1.5">
              {bars.map((height, i) => (
                <span
                  key={i}
                  className="chart-bar inline-block w-full rounded-sm bg-gradient-to-t from-primary/80 to-primary/30"
                  style={{ height: `${height}%`, animationDelay: `${i * -0.45}s` }}
                  aria-hidden="true"
                />
              ))}
            </div>
            <svg className="mt-3 h-6 w-full" viewBox="0 0 200 24" aria-hidden="true">
              <path
                className="spark-fill"
                d="M0 18 L18 15 L36 16 L54 11 L72 13 L90 8 L108 10 L126 6 L144 9 L162 4 L180 6 L200 2"
                fill="none"
                stroke="hsl(var(--primary))"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </div>

          {/* Rows */}
          <div className="space-y-2 border-t border-border bg-card p-3.5 sm:p-4">
            {rows.map((row) => (
              <div
                key={row.name}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/30"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="size-4" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground sm:text-sm">{row.name}</p>
                  <p className="text-[10px] text-muted-foreground sm:text-xs">{row.meta}</p>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className={`block h-full ${row.tone} ${row.width} rounded-full`}
                      aria-hidden="true"
                    />
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white ${row.tone}`}>
                  {row.score}/100
                </span>
              </div>
            ))}
          </div>
        </div>
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
        {/* Always-running tech background: parallax grid, glowing orbs, geometry. */}
        <div className="hero-scene" aria-hidden="true">
          <div className="hero-orb hero-orb--a" />
          <div className="hero-orb hero-orb--b" />
          <div className="hero-orb hero-orb--c" />
          <div className="hero-grid" />
          <div className="hero-tint" />

          {/* Reticle markers */}
          <div className="tech-piece tech-piece--c right-[7%] top-[18%] hidden sm:block">
            <div className="tech-crosshair">
              <span className="tech-crosshair__ring" />
            </div>
          </div>

          <div className="tech-piece tech-piece--d left-[7%] top-[30%] hidden lg:block">
            <div className="tech-crosshair">
              <span className="tech-crosshair__ring" />
            </div>
          </div>

          <div className="tech-piece tech-piece--a bottom-[14%] left-[14%] hidden sm:block">
            <div className="tech-crosshair">
              <span className="tech-crosshair__ring" />
            </div>
          </div>

          <div className="tech-piece tech-piece--b right-[16%] bottom-[8%] hidden sm:block">
            <div className="tech-crosshair">
              <span className="tech-crosshair__ring" />
            </div>
          </div>

          <div className="tech-piece tech-piece--e bottom-[30%] left-[45%] hidden xl:block">
            <div className="tech-crosshair">
              <span className="tech-crosshair__ring" />
            </div>
          </div>
        </div>
        <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-24 sm:px-6 sm:pt-28 lg:pb-24 lg:pt-32">
          <div className="grid items-center gap-14 lg:grid-cols-[1.02fr_0.98fr] lg:gap-10">
            {/* Copy */}
            <div className="text-center lg:text-left">
              <Reveal from="up">
                <p className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
                  <span className="relative flex size-2" aria-hidden="true">
                    <span className="absolute inline-flex size-full rounded-full bg-low-500 opacity-60" />
                    <span className="relative inline-flex size-2 rounded-full bg-low-500" />
                  </span>
                  The Contracting Copilot for modern legal teams
                </p>
              </Reveal>

              <Reveal from="scale">
                <h1 className="hero-headline mt-6 text-4xl font-semibold tracking-tight sm:text-5xl lg:mt-7 lg:text-[3.4rem] lg:leading-[1.05]">
                  Smarter contracts, built in minutes.
                </h1>
              </Reveal>

              <Reveal from="up" delay={120}>
                <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg lg:mx-0">
                  Paqt drafts, reviews, and finalizes agreements end-to-end. Drop the legalese, keep
                  the precision, and close deals in hours, not weeks.
                </p>
              </Reveal>

              <Reveal from="up" delay={200}>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
                  <Button size="lg" className="group" asChild>
                    <Link to={primaryTarget}>
                      {signedIn ? 'Open dashboard' : 'Get started for free'}
                      <ArrowRight className="btn-arrow size-4" aria-hidden="true" />
                    </Link>
                  </Button>
                  <Button size="lg" variant="outline" asChild>
                    <a href="#product">See what it does</a>
                  </Button>
                </div>
              </Reveal>

              <Reveal from="up" delay={280}>
                <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground lg:justify-start">
                  <li className="inline-flex items-center gap-1.5">
                    <Check className="size-3.5 text-low-600" aria-hidden="true" />
                    Clause-level accuracy
                  </li>
                  <li className="inline-flex items-center gap-1.5">
                    <Check className="size-3.5 text-low-600" aria-hidden="true" />
                    Auto-fills parties &amp; dates
                  </li>
                  <li className="inline-flex items-center gap-1.5">
                    <Check className="size-3.5 text-low-600" aria-hidden="true" />
                    Export to Word / PDF
                  </li>
                </ul>
              </Reveal>

              <Reveal from="up" delay={360}>
                <p className="mx-auto mt-8 inline-flex max-w-xl items-center justify-center gap-2 rounded-full border border-border bg-background/70 px-4 py-2 text-center text-xs text-muted-foreground shadow-sm backdrop-blur lg:mx-0">
                  <ShieldCheck className="size-3.5 shrink-0 text-low-600" aria-hidden="true" />
                  Your contract or PDF stays safe with Paqt. Encrypted in transit, and never sold or
                  shared.
                </p>
              </Reveal>
            </div>

            {/* Product visual */}
            <Reveal from="up" delay={160} className="relative">
              <div className="relative mx-auto max-w-xl sm:mx-0">
                {/* Orbital tech geometry */}
                <div className="orbit orbit--outer" aria-hidden="true">
                  <span className="orbit-dot" />
                </div>
                <div className="orbit orbit--mid" aria-hidden="true">
                  <span className="orbit-dot orbit-dot--dim" />
                </div>
                <div className="orbit orbit--inner" aria-hidden="true">
                  <span className="orbit-dot" />
                </div>

                <div className="relative z-10">
                  <AppPreview />
                </div>

                {/* Floating glass chips */}
                <div className="float-chip float-chip--d1 absolute -top-5 right-2 z-20 hidden items-center gap-2 rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur-xl sm:flex">
                  <span className="flex size-5 items-center justify-center rounded-full bg-low-500/15 text-low-600">
                    <Check className="size-3" aria-hidden="true" />
                  </span>
                  NDA generated
                </div>
                <div className="float-chip float-chip--d2 absolute -bottom-6 -left-3 z-20 hidden items-center gap-2.5 rounded-xl border border-border/70 bg-background/80 px-3 py-2 shadow-lg backdrop-blur-xl sm:flex">
                  <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Zap className="size-3" aria-hidden="true" />
                  </span>
                  <span className="text-xs font-medium text-foreground">Risks found · 4</span>
                </div>
                <div className="float-chip float-chip--d3 absolute right-4 -bottom-8 z-20 hidden items-center gap-2 rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur-xl md:flex">
                  <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <Sparkles className="size-3" aria-hidden="true" />
                  </span>
                  Redraft applied
                </div>
                <div className="float-chip float-chip--d4 absolute -left-4 top-1/3 z-20 hidden items-center gap-2 rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur-xl lg:flex">
                  <span className="flex size-5 items-center justify-center rounded-full bg-low-500/15 text-low-600">
                    <Send className="size-3" aria-hidden="true" />
                  </span>
                  Sent for signature
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Document types marquee */}
      <section className="border-t border-border py-8" aria-label="Document types handled by Paqt">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="text-center text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
            Built for every kind of agreement
          </p>
          <div className="marquee mt-5">
            <div className="marquee-track">
              {[0, 1].map((copy) => (
                <ul key={copy} className="flex shrink-0 items-center gap-10" aria-hidden={copy === 1}>
                  {['NDA review', 'M&A contracts', 'Employment agreements', 'SaaS terms', 'Master service agreements', 'Vendor contracts', 'Non-compete clauses', 'IP assignment', 'Data processing agreements', 'Lease agreements'].map((type) => (
                    <li
                      key={type}
                      className="flex items-center gap-3 whitespace-nowrap text-sm font-medium text-muted-foreground"
                    >
                      <span className="size-1.5 rounded-full bg-primary/60" aria-hidden="true" />
                      {type}
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border bg-card/50">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            <p className="tech-mono text-sm font-medium text-primary">The Product</p>
            <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">
              Everything your contracts need in one flow.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Paqt carries a contract from first draft to final signature, with a Contracting
              Copilot that understands both the law and your business.
            </p>
          </div>

          {/* Product demo */}
          <div className="mt-10">
            <div className="mb-4 flex items-center gap-3">
              <span className="tech-mono text-xs font-semibold uppercase tracking-wider text-primary">
                Live demo
              </span>
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
            <Reveal from="scale">
              <div className="overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-[0_24px_64px_-32px_hsl(var(--primary)/0.35)] sm:p-2">
                <div
                  className="relative w-full overflow-hidden rounded-xl bg-muted"
                  style={{ aspectRatio: '1.87', maxHeight: '80svh' }}
                >
                  <iframe
                    src="https://app.supademo.com/embed/cmuzkly5d02edqmpcq754bqca?embed_v=2&utm_source=embed"
                    loading="lazy"
                    title="Draft, Revise, and Analyze Contracts with Paqt"
                    allow="clipboard-write"
                    allowFullScreen
                    className="absolute inset-0 size-full border-0"
                  />
                </div>
              </div>
            </Reveal>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <Reveal key={feature.title} from="up" delay={index * 60}>
                <div
                  className={`group h-full rounded-xl border bg-card p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_hsl(var(--primary)/0.3)] ${
                    // The two capability cards carry the headline; the rest are the
                    // supporting mechanics, so they read as secondary at a glance.
                    feature.feature
                      ? 'border-primary/30 hover:border-primary/40'
                      : 'border-border hover:border-primary/30'
                  }`}
                >
                  <div
                    className={`flex size-9 items-center justify-center rounded-lg transition-transform group-hover:scale-110 ${
                      feature.feature ? 'bg-primary/15 text-primary' : 'bg-primary/10 text-primary'
                    }`}
                  >
                    <feature.icon className="size-4" aria-hidden="true" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-foreground">{feature.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <span id="product" className="block" aria-hidden="true" />
        <div className="max-w-2xl">
          <p className="tech-mono text-sm font-medium text-primary">Product Workflow</p>
          <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">
            From idea to signed deal.
          </h2>
        </div>
        <div className="relative mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div
            className="pointer-events-none absolute inset-x-6 top-6 hidden h-px bg-gradient-to-r from-transparent via-border to-transparent lg:block"
            aria-hidden="true"
          />
          {STEPS.map((step) => (
            <div key={step.number} className="relative rounded-xl border border-border bg-card p-6 shadow-sm">
              <span className="tech-mono inline-flex size-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/5 text-sm font-semibold text-primary">
                {step.number}
              </span>
              <h3 className="mt-4 text-base font-semibold text-foreground">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {step.description}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-10 grid gap-4 rounded-2xl border border-border bg-card p-6 sm:p-8 md:grid-cols-3">
          {USE_CASES.map((useCase, index) => (
            <div key={useCase.label} className="flex flex-col gap-2">
              <p className="tech-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
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
          <p className="tech-mono text-sm font-medium text-primary">FAQ</p>
          <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">
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
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-primary/5 p-8 text-center sm:p-12">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(80%_120%_at_50%_-20%,hsl(var(--primary)/0.12),transparent)]"
            aria-hidden="true"
          />
          <div className="relative">
            <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Ready to work smarter?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Draft, review, and finalize any contract in minutes with Paqt&rsquo;s Contracting
              Copilot.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" className="group" asChild>
                <Link to={primaryTarget}>
                  {signedIn ? 'Open dashboard' : 'Get started for free'}
                  <ArrowRight className="btn-arrow size-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#product">See what it does</a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}