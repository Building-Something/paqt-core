import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { RealtimeChannel, Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { bindHistoryToUser, unbindHistoryToUser, wipeLocalHistory } from '../services/historyService';
import { clearRemoteHistory } from '../services/supabaseHistoryService';
import { clearCheckpoints } from '../services/checkpointService';
import { purgeSubscriptions } from '../services/entitlementService';

export interface AuthActionResult {
  ok: boolean;
  pendingConfirmation: boolean;
  error: string | null;
}

export interface AccountActionResult {
  ok: boolean;
  error: string | null;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  initializing: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<AuthActionResult>;
  signUp: (email: string, password: string) => Promise<AuthActionResult>;
  signOut: () => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<AccountActionResult>;
  deleteAccount: () => Promise<AccountActionResult>;
}

const AUTH_SYNC_CHANNEL = 'paqt-auth-sync';
const AUTH_SYNC_EVENT = 'force_signout';

interface AuthSyncPayload {
  userId: string;
  deviceId: string;
}

function getDeviceId(): string {
  try {
    const key = 'paqt.deviceId.v1';
    const existing = window.localStorage.getItem(key);
    if (existing) {
      return existing;
    }
    const fresh =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `paqt-device-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `paqt-device-${Math.random().toString(36).slice(2)}`;
  }
}

const DEVICE_ID = getDeviceId();

function broadcastForceSignout(userId: string): void {
  if (!supabase) {
    return;
  }
  void (async () => {
    const channel = supabase.channel(AUTH_SYNC_CHANNEL);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('realtime subscribe timed out'));
          }
        }, 10_000);
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(status));
            }
          }
        });
      });
      await channel.send({
        type: 'broadcast',
        event: AUTH_SYNC_EVENT,
        payload: { userId, deviceId: DEVICE_ID } satisfies AuthSyncPayload,
      });
    } catch {
      /* best-effort cross-tab sync */
    } finally {
      await supabase.removeChannel(channel);
    }
  })();
}

const AuthContext = createContext<AuthContextValue | null>(null);

function friendlyAuthError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('already registered')) {
    return 'That email is already registered. Try signing in instead.';
  }
  if (lower.includes('invalid login credentials')) {
    return 'That email or password doesn’t look right. Try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Confirm your email address first, then sign in.';
  }
  if (lower.includes('rate limit')) {
    return 'Too many attempts. Wait a moment and try again.';
  }
  if (lower.includes('password')) {
    return 'Password must be at least 6 characters.';
  }
  return raw;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!supabase) {
      setInitializing(false);
      return () => {
        alive = false;
      };
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) {
        return;
      }
      const nextSession = data.session;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setInitializing(false);
      if (nextSession?.user) {
        void bindHistoryToUser(nextSession.user.id);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!alive) {
        return;
      }
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      if (nextSession?.user) {
        void bindHistoryToUser(nextSession.user.id);
      } else {
        unbindHistoryToUser();
      }
    });

    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !user?.id) {
      return;
    }
    const client = supabase;
    let channel: RealtimeChannel | null = null;
    let alive = true;

    channel = client
      .channel(AUTH_SYNC_CHANNEL)
      .on('broadcast', { event: AUTH_SYNC_EVENT }, (payload) => {
        if (!alive) {
          return;
        }
        const incoming = payload?.payload as AuthSyncPayload | undefined;
        if (!incoming || incoming.userId !== user.id || incoming.deviceId === DEVICE_ID) {
          return;
        }
        void client.auth.signOut({ scope: 'local' });
        unbindHistoryToUser();
      })
      .subscribe();

    return () => {
      alive = false;
      if (channel) {
        void client.removeChannel(channel);
      }
    };
  }, [user?.id]);

  useEffect(() => {
    if (!supabase || !user?.id) {
      return;
    }
    const client = supabase;
    let alive = true;

    const checkSession = async (): Promise<void> => {
      if (!alive) {
        return;
      }
      let sessionDead: boolean;
      try {
        const { data, error } = await client.rpc('auth_session_alive');
        if (error) {
          return;
        }
        sessionDead = data === false;
      } catch {
        return;
      }
      if (!alive || !sessionDead) {
        return;
      }
      await client.auth.signOut({ scope: 'local' });
      unbindHistoryToUser();
    };

    void checkSession();
    const interval = window.setInterval(() => void checkSession(), 30_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void checkSession();
      }
    };
    window.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);

    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [user?.id]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthActionResult> => {
    if (!supabase) {
      return { ok: false, pendingConfirmation: false, error: 'Supabase is not configured.' };
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return { ok: false, pendingConfirmation: false, error: friendlyAuthError(error.message) };
    }
    return { ok: true, pendingConfirmation: false, error: null };
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<AuthActionResult> => {
    if (!supabase) {
      return { ok: false, pendingConfirmation: false, error: 'Supabase is not configured.' };
    }
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      return { ok: false, pendingConfirmation: false, error: friendlyAuthError(error.message) };
    }
    return { ok: true, pendingConfirmation: !data.session, error: null };
  }, []);

  const signOut = useCallback(async () => {
    if (supabase) {
      await supabase.auth.signOut();
    }
    unbindHistoryToUser();
  }, []);

  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string): Promise<AccountActionResult> => {
      if (!supabase || !user?.email) {
        return { ok: false, error: 'Sign in first to change your password.' };
      }
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: oldPassword,
      });
      if (verifyError) {
        return { ok: false, error: 'Current password is incorrect.' };
      }
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        return { ok: false, error: friendlyAuthError(error.message) };
      }
      broadcastForceSignout(user.id);
      try {
        await supabase.auth.signOut({ scope: 'others' });
      } catch {
        /* other sessions may outlive this one */
      }
      return { ok: true, error: null };
    },
    [user?.email, user?.id],
  );

  const deleteAccount = useCallback(async (): Promise<AccountActionResult> => {
    if (!supabase || !user) {
      return { ok: false, error: 'Sign in first to delete your account.' };
    }
    const userId = user.id;

    // No restriction on deletion: every record that could still charge is asked to
    // cancel, but a provider that refuses must not keep the account alive. The
    // outcome is reported to the user instead.
    let billingStopped = true;
    try {
      await purgeSubscriptions();
    } catch {
      billingStopped = false;
    }

    let historyWiped = true;
    try {
      await clearRemoteHistory(userId);
    } catch {
      historyWiped = false;
    }

    let identityRemoved = false;
    if (supabase) {
      const { error } = await supabase.rpc('delete_user');
      identityRemoved = !error;
    }

    broadcastForceSignout(userId);

    // Nothing of a deleted account may survive on this device: erase the cached
    // history mirror, tombstones/payloads and any paused-review checkpoints
    // before the session is cleared.
    try {
      wipeLocalHistory();
    } catch {
      // Best-effort.
    }
    try {
      clearCheckpoints();
    } catch {
      // Best-effort.
    }

    await supabase.auth.signOut();
    unbindHistoryToUser();

    const warnings: string[] = [];
    if (!billingStopped) {
      warnings.push(
        'There was an issue cancelling billing automatically at the payment provider.',
      );
    }
    if (!historyWiped) {
      warnings.push('Some history files could not be wiped automatically.');
    }
    if (!identityRemoved) {
      warnings.push(
        'Your history and files were deleted, but your login record could not be removed automatically. Please contact support to finish deleting your account.',
      );
    }
    return { ok: true, error: warnings.length > 0 ? warnings.join(' ') : null };
  }, [user, signOut, unbindHistoryToUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user,
      initializing,
      configured: isSupabaseConfigured,
      signIn,
      signUp,
      signOut,
      changePassword,
      deleteAccount,
    }),
    [session, user, initializing, signIn, signUp, signOut, changePassword, deleteAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}