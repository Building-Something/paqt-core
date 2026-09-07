import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, Download } from 'lucide-react';
import type { ContractRisk } from '../types';
import { splitDraftIntoSections } from '../utils/draft';
import { downloadTextFile } from '../services/exportService';
import { sanitizedFileName } from '../utils/risks';
import { RiskMarker } from './RiskMarker';
import { MarkdownBody } from './MarkdownBody';

interface DraftViewerProps {
  fileName: string;
  markdown: string;
  currentPage: number;
  totalPages: number;
  risks: ContractRisk[];
  selectedRisk: ContractRisk | null;
  onPageChange: (page: number) => void;
  onSelectRisk: (risk: ContractRisk) => void;
}

const iconButtonClass =
  'inline-flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

export function DraftViewer({
  fileName,
  markdown,
  currentPage,
  totalPages,
  risks,
  selectedRisk,
  onPageChange,
  onSelectRisk,
}: DraftViewerProps) {
  const [copied, setCopied] = useState(false);
  const sectionRefs = useRef<Record<number, HTMLElement | null>>({});

  const sections = useMemo(() => splitDraftIntoSections(markdown), [markdown]);
  const pageMarkers = useMemo(
    () =>
      risks
        .filter((risk) => risk.pageNumber === currentPage)
        .sort((a, b) => a.riskLevel.localeCompare(b.riskLevel)),
    [risks, currentPage],
  );

  useEffect(() => {
    const target = sectionRefs.current[currentPage];
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [currentPage]);

  function goToSection(page: number) {
    if (page < 1 || page > totalPages) {
      return;
    }
    onPageChange(page);
  }

  async function handleCopy() {
    if (!markdown) {
      return;
    }
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable; leave the copy affordance available.
    }
  }

  function handleDownload() {
    downloadTextFile(
      sanitizedFileName(fileName, 'draft.md'),
      markdown,
      'text/markdown;charset=utf-8',
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/40">
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-background px-3 py-2">
        <p className="mr-2 min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {fileName}
        </p>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous section"
            title="Previous section"
            onClick={() => goToSection(currentPage - 1)}
            disabled={currentPage <= 1}
            className={iconButtonClass}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <span className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs font-medium tabular-nums text-muted-foreground">
            Section {currentPage}
            <span className="text-muted-foreground/70"> / {totalPages}</span>
          </span>
          <button
            type="button"
            aria-label="Next section"
            title="Next section"
            onClick={() => goToSection(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className={iconButtonClass}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        <button
          type="button"
          aria-label="Copy draft as Markdown"
          title="Copy draft as Markdown"
          onClick={handleCopy}
          className={iconButtonClass}
        >
          {copied ? (
            <Check className="size-4 text-low-600" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label="Download draft as Markdown"
          title="Download draft as Markdown"
          onClick={handleDownload}
          className={iconButtonClass}
        >
          <Download className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-5">
          {sections.map((section) => (
            <section
              key={section.pageNumber}
              ref={(node) => {
                sectionRefs.current[section.pageNumber] = node;
              }}
              aria-label={`Section ${section.pageNumber}: ${section.heading}`}
              data-testid={`draft-section-${section.pageNumber}`}
              className={[
                'relative rounded-xl border bg-card p-5 shadow-sm transition-shadow',
                section.pageNumber === currentPage
                  ? 'border-primary/60 ring-1 ring-primary/30'
                  : 'border-border',
              ].join(' ')}
            >
              {section.pageNumber === currentPage && pageMarkers.length > 0 ? (
                <div className="absolute right-3 top-3 z-10 flex max-w-[75%] flex-wrap items-start justify-end gap-2">
                  {pageMarkers.map((risk, index) => (
                    <RiskMarker
                      key={risk.id}
                      risk={risk}
                      number={index + 1}
                      selected={selectedRisk?.id === risk.id}
                      onSelect={onSelectRisk}
                    />
                  ))}
                </div>
              ) : null}

              <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold text-foreground">
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {section.pageNumber}
                </span>
                {section.heading}
              </h2>
              <div className="text-foreground/90">
                <MarkdownBody>{section.text}</MarkdownBody>
              </div>
            </section>
          ))}

          <p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">
            This draft is a starting point, not legal advice. Have qualified
            counsel review it before signing.
          </p>
        </div>
      </div>
    </div>
  );
}