import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { bindHistoryToUser, unbindHistoryToUser } from '../services/historyService';
import { clearRemoteHistory } from '../services/supabaseHistoryService';

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
      return { ok: true, error: null };
    },
    [user?.email],
  );

  const deleteAccount = useCallback(async (): Promise<AccountActionResult> => {
    if (!supabase || !user) {
      return { ok: false, error: 'Sign in first to delete your account.' };
    }
    const userId = user.id;

    let historyWiped = true;
    try {
      await clearRemoteHistory(userId);
    } catch {
      historyWiped = false;
    }

    let identityRemoved = false;
    if (supabase && historyWiped) {
      const { error } = await supabase.rpc('delete_user');
      identityRemoved = !error;
      if (error) {
        console.debug('[paqt] delete_user RPC failed:', error.message);
      }
    }

    await supabase.auth.signOut();
    unbindHistoryToUser();

    return {
      ok: true,
      error: historyWiped
        ? identityRemoved
          ? null
          : 'Your history and files were deleted, but your login record still exists in Supabase Auth. Run the delete_user SQL from supabase/schema.sql in the Supabase dashboard (Account -> SQL editor) to permanently remove the login, or delete the user under Authentication -> Users.'
        : 'Your files were removed, but some history could not be wiped automatically.',
    };
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