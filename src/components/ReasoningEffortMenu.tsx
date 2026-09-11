import { Gauge } from 'lucide-react';
import { useSettings } from '../contexts/SettingsContext';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import type { ReasoningEffort } from '../services/groqService';

const EFFORTS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest, fewest tokens' },
  { value: 'medium', label: 'Medium', hint: 'Balanced speed and depth' },
  { value: 'high', label: 'High', hint: 'Deepest analysis, slowest' },
];

export function ReasoningEffortMenu() {
  const { reasoningEffort, setReasoningEffort } = useSettings();
  const current =
    EFFORTS.find((effort) => effort.value === reasoningEffort) ?? EFFORTS[1];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Gauge className="size-4" aria-hidden="true" />
          Reasoning: {current.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
        <p className="px-2 pb-1 text-xs leading-relaxed text-muted-foreground">
          Applied to every AI call in Paqt — analysis, cross-clause checks,
          drafting and chat. Lower is faster and uses fewer tokens.
        </p>
        <DropdownMenuRadioGroup
          value={reasoningEffort}
          onValueChange={(value) => setReasoningEffort(value as ReasoningEffort)}
        >
          {EFFORTS.map((effort) => (
            <DropdownMenuRadioItem key={effort.value} value={effort.value}>
              <span className="font-medium">{effort.label}</span>
              <span className="ml-auto pl-4 text-xs text-muted-foreground">
                {effort.hint}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}