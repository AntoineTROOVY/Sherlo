import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';

/** Sent so an account with no WhatsApp sessions is scoped to nothing. An empty list means "every session". */
export const ACCOUNT_SCOPE_NONE = '00000000-0000-0000-0000-000000000000';

const DEV_SECRET = 'sherlo-dev-better-auth-secret-do-not-use';

export interface AccountIdentity {
  id: string;
  email: string;
  role: 'admin' | 'user';
  /** Null for an instance admin (sees every session). A list for everyone else. */
  sessionIds: string[] | null;
}

export interface AccountApiKey extends ApiKey {
  accountUserId: string;
}

export function accountUserIdOf(key: ApiKey | undefined): string | undefined {
  const id = (key as AccountApiKey | undefined)?.accountUserId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The first account can always be created. Further sign-ups stay closed unless
 * BETTER_AUTH_OPEN_SIGNUP=true, so a public Dokploy URL does not accept strangers by default.
 */
export function signupOpen(userCount: number, openSignup: string | undefined): boolean {
  if (userCount <= 0) return true;
  return openSignup?.trim().toLowerCase() === 'true';
}

export function resolveBetterAuthSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? '';
  if (secret.length >= 32) return secret;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'BETTER_AUTH_SECRET must be set to a random string of at least 32 characters before production boot',
    );
  }
  return DEV_SECRET;
}

export function resolveBetterAuthBaseURL(env: NodeJS.ProcessEnv): string {
  const explicit = env.BETTER_AUTH_URL?.trim() || env.BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = env.PORT?.trim() || '2785';
  return `http://localhost:${port}`;
}

/** Origins Better Auth will accept on cookie requests (the public URL, the dashboard, and CORS). */
export function resolveTrustedOrigins(env: NodeJS.ProcessEnv): string[] {
  const origins = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed === '*') return;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // A value that is not an absolute URL cannot be an Origin header.
    }
  };
  add(resolveBetterAuthBaseURL(env));
  add(env.DASHBOARD_URL);
  for (const part of (env.CORS_ORIGINS ?? '').split(',')) add(part);
  if (env.NODE_ENV !== 'production') {
    add('http://localhost:2886');
    add('http://localhost:2785');
    add('http://127.0.0.1:2886');
    add('http://127.0.0.1:2785');
  }
  return [...origins];
}

export function authDatabasePath(env: NodeJS.ProcessEnv): string {
  const configured = env.AUTH_DATABASE_PATH?.trim();
  return configured && configured.length > 0 ? configured : './data/auth.sqlite';
}

/**
 * An in-memory API key that lets the existing guard, roles, and session fence treat a Better Auth
 * account as the caller. It is never written to api_keys.
 */
export function syntheticAccountKey(identity: AccountIdentity): AccountApiKey {
  const admin = identity.role === 'admin';
  // Dashboard accounts are never session-scoped via allowedSessions: non-admins are fenced by
  // session.ownerUserId instead, so a new member with zero sessions can still POST /sessions.
  const allowedSessions = null;
  return {
    id: identity.id,
    name: identity.email,
    keyHash: '',
    keyPrefix: 'account',
    role: admin ? ApiKeyRole.ADMIN : ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions,
    allowedChats: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    accountUserId: identity.id,
  };
}
