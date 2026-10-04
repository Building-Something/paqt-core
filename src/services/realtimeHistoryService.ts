import { supabase } from '../lib/supabase';

/**
 * Live change pump for account history.
 *
 * Supabase Realtime pushes `postgres_changes` events for the signed-in user's
 * own `documents` rows. This service wraps that channel with a tiny API so the
 * rest of the app can "just" ask to be told whenever anything in the remote
 * history changed — no manual refresh, no polling.
 *
 * The table must be part of the `supabase_realtime` publication:
 *   alter publication supabase_realtime add table public.documents;
 * (already applied on the live project — if a new project is ever spun up,
 * re-run that in the SQL editor once.)
 */

let sharedChannel: Awaited<ReturnType<NonNullable<typeof supabase>['channel']>> | null = null;
let activeUserId: string | null = null;

interface ChangeRow {
  user_id?: string | null;
}

/** True when a realtime payload maps to the user we care about. */
function rowBelongsToUser(row: ChangeRow | null | undefined, userId: string): boolean {
  return Boolean(row && (row.user_id === userId || row.user_id === null));
}

/**
 * Starts listening for every insert/update/delete on the caller's own
 * `documents` rowscurrent and calls `onChange()` each time. Returns a function
 * that stops the subscription.
 */
export function subscribeHistoryRealtime(userId: string, onChange: () => void): () => void {
  if (!supabase || !userId) {
    return () => undefined;
  }
  if (sharedChannel && activeUserId === userId) {
    return () => undefined;
  }
  activeUserId = userId;
  let disposed = false;

  const channel = supabase
    .channel(`paqt-history-${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'documents',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        if (disposed) {
          return;
        }
        // DELETE payloads carry the row in `old`; inserts/updates carry it in
        // `new`. Check whichever matches this row's event type.
        const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
        if (rowBelongsToUser(row as ChangeRow | null, userId)) {
          onChange();
        }
      },
    )
    .subscribe();

  const unsubscribe = () => {
    disposed = true;
    if (activeUserId === userId) {
      void supabase!.removeChannel(channel);
      activeUserId = null;
    }
  };
  sharedChannel = channel;

  return unsubscribe;
}
