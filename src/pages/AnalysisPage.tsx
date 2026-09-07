import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, GitCompareArrows } from 'lucide-react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAnalysis } from '../contexts/AnalysisContext';
import type { ContractRisk } from '../types';
import { AnalysisProgress } from '../components/AnalysisProgress';
import { ContractSummary } from '../components/ContractSummary';
import { RiskBreakdown } from '../components/RiskBreakdown';
import { RiskList } from '../components/RiskList';
import { PdfViewer } from '../components/PdfViewer';
import { DraftViewer } from '../components/DraftViewer';
import { ChatInterface } from '../components/ChatInterface';
import { ExportButton } from '../components/ExportButton';
import { ErrorState } from '../components/ErrorState';
import { Disclaimer } from '../components/Disclaimer';
import { Button } from '../components/ui/button';

type MobileTab = 'summary' | 'document' | 'assistant';

export function AnalysisPage() {
  const {
    file,
    fileName,
    pages,
    draftMarkdown,
    isDraft,
    analysis,
    selectedRisk,
    progress,
    error,
    retryAnalysis,
    selectRisk,
    setCurrentPage,
    currentPage,
  } = useAnalysis();

  const [mobileTab, setMobileTab] = useState<MobileTab>('summary');
  const [searchParams] = useSearchParams();
  const openedIdRef = useRef<string | null>(null);

  const { openEntry, record } = useAnalysis();

  const pagesText = useMemo(() => pages.map((page) => page.text), [pages]);
  const totalPages = pages.length;
  const isRecord = record !== null && !file && !isDraft;
  const title = record?.name ?? fileName;

  const requestedId = searchParams.get('id');
  useEffect(() => {
    if (!requestedId || openedIdRef.current === requestedId) {
      return;
    }
    openedIdRef.current = requestedId;
    void openEntry(requestedId);
  }, [requestedId, openEntry]);

  useEffect(() => {
    if (selectedRisk) {
      setCurrentPage(selectedRisk.pageNumber);
    }
  }, [selectedRisk, setCurrentPage]);

  useEffect(() => {
    document.title = selectedRisk
      ? `${selectedRisk.category} · Paqt`
      : `${title || 'Analysis'} · Paqt`;
    return () => {
      document.title = 'Paqt — Know what you’re signing.';
    };
  }, [title, selectedRisk]);

  if (!file && !isDraft && !record) {
    return <Navigate to="/analyze" replace />;
  }

  const handleSelectRisk = (risk: ContractRisk) => {
    selectRisk(risk);
    if (!isRecord) {
      setCurrentPage(risk.pageNumber);
      setMobileTab('document');
    }
  };

  const unitLabel = isDraft ? 'section' : 'page';

  const headerMeta = isRecord
    ? 'Archived analysis'
    : progress.stage === 'complete' && analysis
      ? `${totalPages} ${unitLabel}${totalPages === 1 ? '' : 's'} · analysis complete`
      : progress.label;

  const documentPane = isRecord ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/40 p-6 text-center">
      <div className="rounded-full bg-muted p-3 text-muted-foreground">
        <FileText className="size-6" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-foreground">
        Original PDF not retained
      </p>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        Paqt doesn’t store your uploaded document after analysis. Re-upload the
        PDF to review it page by page or ask follow-up questions.
      </p>
      <Button variant="outline" asChild>
        <Link to="/analyze">Re-analyze a contract</Link>
      </Button>
    </div>
  ) : file ? (
    <PdfViewer
      file={file}
      fileName={fileName}
      currentPage={currentPage}
      totalPages={totalPages}
      pagesText={pagesText}
      risks={analysis?.risks ?? []}
      selectedRisk={selectedRisk}
      onPageChange={setCurrentPage}
      onSelectRisk={handleSelectRisk}
    />
  ) : (
    <DraftViewer
      fileName={fileName}
      markdown={draftMarkdown}
      currentPage={currentPage}
      totalPages={totalPages}
      risks={analysis?.risks ?? []}
      selectedRisk={selectedRisk}
      onPageChange={setCurrentPage}
      onSelectRisk={handleSelectRisk}
    />
  );

  const activeTabClass = (tab: MobileTab) =>
    mobileTab === tab
      ? 'border-foreground text-foreground'
      : 'border-transparent text-muted-foreground hover:text-foreground';

  return (
    <div className="flex flex-col lg:h-[100dvh]">
      {/* Studio header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="rounded-md bg-muted p-2 text-muted-foreground">
            <FileText className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{headerMeta}</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ExportButton />
        </div>
      </div>

      {/* Mobile tabs */}
      {!isRecord ? (
        <div
          className="flex border-b border-border bg-background lg:hidden"
          role="tablist"
          aria-label="Analysis sections"
        >
          {(
            [
              ['summary', 'Summary'],
              ['document', 'Document'],
              ['assistant', 'Assistant'],
            ] as [MobileTab, string][]
          ).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mobileTab === tab}
              onClick={() => setMobileTab(tab)}
              className={`flex-1 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${activeTabClass(tab)}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="mx-auto w-full max-w-2xl px-4 py-10">
          <ErrorState
            message={error.message}
            onRetry={error.retriable ? retryAnalysis : undefined}
            retryLabel="Retry analysis"
          />
          <div className="mt-4">
            <Disclaimer />
          </div>
        </div>
      ) : !analysis ? (
        <div className="mx-auto w-full max-w-2xl px-4 py-10">
          <AnalysisProgress
            progress={progress}
            fileName={fileName}
          />
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            <GitCompareArrows className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <span>
              The document is processed in chunks so large contracts stay
              accurate without losing context.
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* Desktop three-zone grid */}
          <div className="hidden min-h-0 flex-1 grid-cols-[380px_1fr_360px] gap-0 lg:grid xl:grid-cols-[420px_1fr_400px]">
            <aside className="min-h-0 overflow-y-auto border-r border-border bg-background">
              <div className="space-y-6 p-5">
                <section aria-labelledby="summary-heading">
                  <h2 id="summary-heading" className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Decision brief
                  </h2>
                  <ContractSummary analysis={analysis} />
                </section>
                <section aria-labelledby="breakdown-heading">
                  <h2 id="breakdown-heading" className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Risk breakdown
                  </h2>
                  <RiskBreakdown risks={analysis.risks} />
                </section>
                <section aria-labelledby="risks-heading" className="border-t border-border pt-5">
                  <h2 id="risks-heading" className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Risks ({analysis.risks.length})
                  </h2>
                  <RiskList
                    risks={analysis.risks}
                    selectedRiskId={selectedRisk?.id ?? null}
                    onSelectRisk={handleSelectRisk}
                  />
                </section>
                <div className="mt-6 border-t border-border pt-4">
                  <Disclaimer />
                </div>
              </div>
            </aside>

            <section
              className="min-w-0 min-h-0 bg-muted/40"
              aria-label="Document viewer"
            >
              {documentPane}
            </section>

            <aside className="min-h-0 overflow-hidden border-l border-border bg-background">
              <ChatInterface disabled={isRecord} />
            </aside>
          </div>

          {/* Mobile stacked layout */}
          {isRecord ? (
            <div className="space-y-6 bg-muted/40 px-4 py-5 lg:hidden">
              <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                This is an archived review. The original PDF isn’t stored after
                analysis — re-upload to view it page by page or ask questions.
              </div>
              <ContractSummary analysis={analysis} />
              <RiskBreakdown risks={analysis.risks} />
              <RiskList
                risks={analysis.risks}
                selectedRiskId={selectedRisk?.id ?? null}
                onSelectRisk={handleSelectRisk}
              />
              <Disclaimer />
            </div>
          ) : (
            <div className="lg:hidden">
              {mobileTab === 'summary' ? (
                <div className="space-y-6 bg-muted/40 px-4 py-5">
                  {analysis ? (
                    <>
                      <ContractSummary analysis={analysis} />
                      <RiskBreakdown risks={analysis.risks} />
                    </>
                  ) : null}
                </div>
              ) : null}

              {mobileTab === 'document' ? (
                <div className="h-[calc(100dvh-9rem)] bg-muted/40">
                  {documentPane}
                </div>
              ) : null}

              {mobileTab === 'assistant' ? (
                <div className="h-[calc(100dvh-9rem)] bg-background">
                  <ChatInterface disabled={isRecord} />
                </div>
              ) : null}

              {mobileTab === 'summary' ? (
                <div className="border-t border-border bg-background px-4 py-4">
                  <div className="mb-4">
                    <RiskList
                      risks={analysis.risks}
                      selectedRiskId={selectedRisk?.id ?? null}
                      onSelectRisk={handleSelectRisk}
                    />
                  </div>
                  <Disclaimer />
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}