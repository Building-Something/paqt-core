import type { ChatMessage as ChatMessageType } from '../types';
import { Bot, UserRound } from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';

interface ChatMessageProps {
  message: ChatMessageType;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.sender === 'user';

  return (
    <div
      className={[
        'flex items-start gap-3',
        isUser ? 'flex-row-reverse' : '',
      ].join(' ')}
    >
      <div
        className={[
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-ink-800 text-white' : 'bg-primary-100 text-primary-700',
        ].join(' ')}
        aria-hidden="true"
      >
        {isUser ? <UserRound className="size-4" /> : <Bot className="size-4" />}
      </div>
      <div
        className={[
          'min-w-0 rounded-2xl px-4 py-3',
          isUser
            ? 'max-w-[85%] rounded-tr-sm bg-ink-800 text-white'
            : 'max-w-none flex-1 rounded-tl-sm border border-ink-200 bg-white text-ink-800',
        ].join(' ')}
      >
        <p
          className={`text-xs font-medium ${isUser ? 'text-white/70' : 'text-ink-400'}`}
        >
          {isUser ? 'You' : 'Paqt'}
          <span className="ml-2 font-normal">{formatTime(message.timestamp)}</span>
        </p>
        {isUser ? (
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
        ) : (
          <div className="mt-1 min-w-0">
            <MarkdownBody>{message.text}</MarkdownBody>
          </div>
        )}
      </div>
    </div>
  );
}