import { Link } from 'react-router-dom';
import { ArrowRight, FileSearch, ScrollText, Scale } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';

const PRINCIPLES = [
  {
    icon: FileSearch,
    title: 'Evidence before explanation',
    description:
      'Every material risk points to a real page and quotes the underlying clause. Paqt never lists a finding it cannot tie back to the extracted text.',
  },
  {
    icon: ScrollText,
    title: 'Built for real documents',
    description:
      'Longer contracts are analyzed incrementally, page by page, so large documents stay accurate instead of being crammed into one unreliable call.',
  },
  {
    icon: Scale,
    title: 'Honest about its limits',
    description:
      'Paqt flags things worth attention and explains them plainly, so you can verify every finding against the document before acting.',
  },
];

export function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
      >
        <ArrowRight className="size-4 rotate-180" aria-hidden="true" />
        Back home
      </Link>

      <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground">
        About Paqt
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
        Paqt is the contract decision layer before you sign. It helps founders,
        freelancers, and small teams understand what they’re agreeing to without
        paying for a full legal review every time.
      </p>

      <div className="mt-10 space-y-4">
        {PRINCIPLES.map((principle) => (
          <Card key={principle.title}>
            <CardContent className="flex items-start gap-4 p-6">
              <div className="rounded-lg bg-muted p-2 text-primary">
                <principle.icon className="size-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {principle.title}
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {principle.description}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-10 rounded-xl border border-primary/20 bg-primary/5 p-6">
        <h2 className="text-lg font-semibold text-foreground">The distinction</h2>
        <p className="mt-2 text-sm leading-relaxed text-foreground/80">
          Generic summarizers produce prose. Paqt produces decisions you can
          inspect: what matters, where it lives in the document, why it matters,
          and what you should do next. That difference is the whole point.
        </p>
      </div>
    </div>
  );
}