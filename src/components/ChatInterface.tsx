import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Lightbulb, SendHorizonal } from 'lucide-react';
import type { ContractRisk } from '../types';
import { useAnalysis } from '../contexts/AnalysisContext';
import { ChatMessage } from './ChatMessage';
import { EmptyState } from './EmptyState';

const SUGGESTED_PROMPTS = [
  'What should I negotiate?',
  'Summarize the termination terms.',
  'What happens if the other side delays payment?',
];

interface ChatInterfaceProps {
  disabled?: boolean;
}

export function ChatInterface({ disabled = false }: ChatInterfaceProps) {
  const { analysis, chatMessages, isChatBusy, sendMessage, selectedRisk } =
    useAnalysis();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [chatMessages, isChatBusy]);

  function submitQuestion(text?: string) {
    const question = (text ?? draft).trim();
    if (!question || isChatBusy) {
      return;
    }
    void sendMessage(question);
    setDraft('');
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submitQuestion();
  }

  function discussSelectedRisk(risk: ContractRisk) {
    void sendMessage(
      `Can you explain the risk flagged on page ${risk.pageNumber}: "${risk.text}"?`,
    );
  }

  if (!analysis) {
    return <EmptyState title="No contract loaded" />;
  }

  if (disabled) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-ink-200 bg-white px-5 py-4">
          <h2 className="text-sm font-semibold text-ink-800">
            Contract assistant
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Ask questions specific to this contract.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-ink-50 px-5 py-8">
          <EmptyState
            title="Archived session"
            description="The original PDF isn’t retained after analysis, so chat isn’t available from history. Re-upload the contract and run a fresh analysis to ask questions."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-ink-200 bg-white px-5 py-4">
        <h2 className="text-sm font-semibold text-ink-800">
          Contract assistant
        </h2>
        <p className="mt-0.5 text-xs text-ink-500">
          Ask questions specific to this contract.
        </p>
      </div>

      {selectedRisk ? (
        <div className="border-b border-primary-200 bg-primary-50 px-5 py-3">
          <p className="truncate text-xs text-ink-600">
            <span className="font-semibold text-ink-800">Selected risk</span> ·{' '}
            {selectedRisk.category} (page {selectedRisk.pageNumber})
          </p>
          <button
            type="button"
            onClick={() => discussSelectedRisk(selectedRisk)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-700"
          >
            <Lightbulb className="size-3.5" aria-hidden="true" />
            Explain this clause
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-ink-50 px-4 py-4"
        aria-live="polite"
      >
        {chatMessages.length === 0 ? (
          <div className="flex flex-col gap-3 px-1">
            <p className="text-sm leading-relaxed text-ink-600">
              Paqt found {analysis.risks.length} risk
              {analysis.risks.length === 1 ? '' : 's'} in this contract. Ask a
              question or click a risk card to dig into the evidence.
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => submitQuestion(prompt)}
                  disabled={isChatBusy}
                  className="rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:border-primary-400 hover:text-primary-700 disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chatMessages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))
        )}

        {isChatBusy ? (
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-700">
              <span className="flex gap-1" aria-label="Paqt is thinking">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="size-1.5 animate-bounce rounded-full bg-primary-600"
                    style={{ animationDelay: `${dot * 120}ms` }}
                  />
                ))}
              </span>
            </div>
            <div className="rounded-2xl rounded-tl-sm border border-ink-200 bg-white px-4 py-3 text-xs text-ink-400">
              Paqt is checking the contract…
            </div>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={handleSubmit}
        className="border-t border-ink-200 bg-white p-3"
      >
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Ask about this contract
          </label>
          <textarea
            id="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitQuestion();
              }
            }}
            placeholder="Ask about a clause, page, or term…"
            rows={1}
            className="input max-h-32 min-h-[42px] resize-none leading-relaxed"
          />
          <button
            type="submit"
            aria-label="Send message"
            disabled={!draft.trim() || isChatBusy}
            className="btn-primary h-[42px] shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <SendHorizonal className="size-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
          Paqt’s answers are informational and may reference qualified legal
          counsel.
        </p>
      </form>
    </div>
  );
}