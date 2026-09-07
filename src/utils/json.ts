import { GroqServiceError } from '../services/errors';

export function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fenced/prose extraction
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to object extraction
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // invalid JSON surfaces via the error below
    }
  }

  throw new GroqServiceError(
    'invalid_json',
    'AI returned an unexpected analysis format. Please retry.',
  );
}