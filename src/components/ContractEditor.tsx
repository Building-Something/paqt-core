import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { useEffect, useRef } from 'react';
import { type ContractDocNode } from '../utils/contractDocument';
import { ContractToolbar } from './ContractToolbar';

interface ContractEditorProps {
  doc: ContractDocNode;
  contentKey?: number | string;
  editable?: boolean;
  onChange: (doc: ContractDocNode) => void;
}

export function ContractEditor({ doc, contentKey = 0, editable = true, onChange }: ContractEditorProps) {
  const seenKey = useRef<number | string>(contentKey);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: doc as unknown as JSONContent,
    editable,
    onUpdate: ({ editor: current }) => {
      onChange(current.getJSON() as unknown as ContractDocNode);
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    if (seenKey.current === contentKey) {
      editor.setEditable(editable);
      return;
    }
    seenKey.current = contentKey;
    editor.commands.setContent(doc as unknown as JSONContent, false);
    onChange(editor.getJSON() as unknown as ContractDocNode);
  }, [contentKey, doc, editable, editor, onChange]);

  return (
    <div className="contract-sheet flex min-h-0 flex-1 flex-col">
      <ContractToolbar editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 py-8 sm:px-10">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}