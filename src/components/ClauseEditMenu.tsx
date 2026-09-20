import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import { useState } from 'react';
import {
  Languages,
  Pencil,
  Scissors,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import type { ContractDocNode } from '../utils/contractDocument';
import { sectionContextAround } from '../utils/contractDocument';
import {
  rewriteSelectedClause,
  type ClauseEditAction,
} from '../services/draftService';

const ACTIONS: { action: ClauseEditAction; label: string; title: string; icon: typeof Pencil }[] = [
  { action: 'rewrite', label: 'Rewrite', title: 'Clearer, more precise legal language', icon: Pencil },
  { action: 'simplify', label: 'Simplify', title: 'Same meaning, plainer English', icon: Languages },
  { action: 'strengthen', label: 'Strengthen', title: 'More favorable to the drafting party', icon: ShieldCheck },
  { action: 'shorten', label: 'Shorten', title: 'Cut to the essential terms', icon: Scissors },
];

function replacementContent(text: string): Array<{ type: 'paragraph'; content: Array<{ type: 'text'; text: string }> }> {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: paragraph }],
    }));
}

export function ClauseEditMenu({ editor }: { editor: Editor }) {
  const [busyAction, setBusyAction] = useState<ClauseEditAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: ClauseEditAction) {
    if (busyAction) {
      return;
    }
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, '\n');
    if (from === to || !selectedText.trim()) {
      return;
    }
    setBusyAction(action);
    setError(null);
    try {
      const sectionContext = sectionContextAround(
        editor.getJSON() as ContractDocNode,
        from,
      );
      const replacement = await rewriteSelectedClause(action, selectedText, sectionContext);
      const content = replacementContent(replacement);
      if (content.length === 0) {
        throw new Error('empty-rewrite');
      }
      editor.chain().focus().insertContentAt({ from, to }, content).run();
    } catch (caught) {
      console.error('Clause edit failed', caught);
      setError('Couldn’t apply this edit. Please try again.');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <BubbleMenu editor={editor}>
      <div className="flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
        {ACTIONS.map((entry) => (
          <button
            key={entry.action}
            type="button"
            title={entry.title}
            aria-label={entry.title}
            disabled={busyAction !== null}
            onClick={() => void run(entry.action)}
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-popover-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === entry.action ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <entry.icon className="size-3.5" aria-hidden="true" />
            )}
            {entry.label}
          </button>
        ))}
        {error ? (
          <span className="px-2 text-[11px] font-medium text-destructive">{error}</span>
        ) : null}
      </div>
    </BubbleMenu>
  );
}