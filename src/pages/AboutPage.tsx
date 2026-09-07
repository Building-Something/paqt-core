import { Link } from 'react-router-dom';
import { ArrowRight, FileSearch, ScrollText, Scale } from 'lucide-react';
import { Disclaimer } from '../components/Disclaimer';

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
      'Paqt is informational, not legal advice. It flags things worth attention and explains them plainly — final judgement stays with you and your counsel.',
  },
];

export function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-700 hover:text-primary-800"
      >
        <ArrowRight className="size-4 rotate-180" aria-hidden="true" />
        Back home
      </Link>

      <h1 className="mt-6 text-4xl font-bold tracking-tight text-ink-900">
        About Paqt
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-600">
        Paqt is the contract decision layer before you sign. It helps founders,
        freelancers, and small teams understand what they’re agreeing to without
        paying for a full legal review every time.
      </p>

      <div className="mt-10 space-y-4">
        {PRINCIPLES.map((principle) => (
          <div key={principle.title} className="card flex items-start gap-4 p-6">
            <div className="rounded-lg bg-primary-100 p-2 text-primary-700">
              <principle.icon className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink-900">{principle.title}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                {principle.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-primary-200 bg-primary-50/60 p-6">
        <h2 className="text-lg font-semibold text-ink-900">
          The distinction
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">
          Generic summarizers produce prose. Paqt produces decisions you can
          inspect: what matters, where it lives in the document, why it matters,
          and what you should do next. That difference is the whole point.
        </p>
      </div>

      <div className="mt-10">
        <Disclaimer />
      </div>
    </div>
  );
}