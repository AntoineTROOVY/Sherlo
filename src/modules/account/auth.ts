import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IncomingHttpHeaders } from 'http';
import type { Request, Response } from 'express';
import Database from 'better-sqlite3';
import {
  authDatabasePath,
  resolveBetterAuthBaseURL,
  resolveBetterAuthSecret,
  resolveTrustedOrigins,
  signupOpen,
} from './account-actor';
import { resolvePolarSettings } from './polar-config';
import { createSendResetPassword, createSendVerificationOTP, resolveResendConfig } from './account-resend';
import { polarPlugins } from './polar-plugin';
import { resolveStripeSettings } from './stripe-config';
import { stripePlugins } from './stripe-plugin';

/** Mounted beside the existing /api/auth API-key routes, not on top of them. */
export const BETTER_AUTH_BASE_PATH = '/api/account';

export interface StartedAuth {
  auth: AuthInstance['auth'];
  fromNodeHeaders: AuthInstance['fromNodeHeaders'];
  /** True when POLAR_ACCESS_TOKEN is set and checkout is mounted. */
  polar: boolean;
  /** True when subscription webhooks are signed with POLAR_WEBHOOK_SECRET. */
  polarWebhooks: boolean;
  /** True when RESEND_API_KEY is set and password-reset emails can be sent. */
  passwordReset: boolean;
  /** True when sign-up requires email OTP verification via Resend. */
  emailVerification: boolean;
  /** True when STRIPE_SECRET_KEY and STRIPE_PRICE_ID are set. */
  stripe: boolean;
  /** Resolved path to auth.sqlite (for ops logging). */
  authDatabaseFile: string;
  /** Number of Better Auth user rows after migration. */
  accountUserCount: number;
}

type AuthInstance = Awaited<ReturnType<typeof buildAuth>>;

let starting: Promise<AuthInstance> | null = null;
let handler: ((req: Request, res: Response) => Promise<unknown>) | null = null;

/**
 * Better Auth is ESM-only. This codebase emits CommonJS, so a static import becomes require() and
 * crashes at boot. import() stays a native dynamic import under the nodenext emit, which Node can
 * load. The instance is created once, on first use.
 */
export function startAuth(): Promise<StartedAuth> {
  starting ??= buildAuth();
  return starting;
}

export function accountAuthMiddleware(req: Request, res: Response, next: (error?: unknown) => void): void {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
  if (path !== BETTER_AUTH_BASE_PATH && !path.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) {
    next();
    return;
  }
  if (!handler) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'Account auth is not ready' }));
    return;
  }
  void handler(req, res).catch(next);
}

async function buildAuth() {
  const [{ betterAuth }, { APIError, createAuthMiddleware }, { toNodeHandler, fromNodeHeaders }, { getMigrations }] =
    await Promise.all([
      import('better-auth'),
      import('better-auth/api'),
      import('better-auth/node'),
      import('better-auth/db/migration'),
    ]);

  const databaseFile = authDatabasePath(process.env);
  mkdirSync(dirname(databaseFile), { recursive: true });
  const sqlite = new Database(databaseFile);

  const userCount = (): number => {
    try {
      const row = sqlite.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  };

  const baseURL = resolveBetterAuthBaseURL(process.env);
  const secureCookies = baseURL.startsWith('https://');
  const stripeSettings = resolveStripeSettings(process.env);
  const polar = stripeSettings ? null : resolvePolarSettings(process.env);
  const resendReady = resolveResendConfig(process.env) !== null;
  const sendResetPassword = createSendResetPassword(process.env);
  const passwordReset = resendReady;
  const emailVerification = resendReady;

  const plugins: Awaited<ReturnType<typeof polarPlugins>> = [];
  if (emailVerification) {
    const { emailOTP } = await import('better-auth/plugins/email-otp');
    plugins.push(
      emailOTP({
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        storeOTP: 'hashed',
        sendVerificationOTP: createSendVerificationOTP(process.env),
      }),
    );
  }
  if (stripeSettings) {
    plugins.push(...(await stripePlugins(stripeSettings, process.env)));
  } else if (polar) {
    plugins.push(...(await polarPlugins(polar, process.env)));
  }

  const options = {
    appName: 'Sherlo',
    baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: resolveBetterAuthSecret(process.env),
    trustedOrigins: resolveTrustedOrigins(process.env),
    database: sqlite,
    ...(emailVerification
      ? {
          emailVerification: {
            sendOnSignIn: true,
            autoSignInAfterVerification: true,
          },
        }
      : {}),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: !emailVerification,
      requireEmailVerification: emailVerification,
      ...(sendResetPassword ? { sendResetPassword } : {}),
    },
    user: {
      additionalFields: {
        role: {
          type: 'string' as const,
          required: false,
          defaultValue: 'user',
          input: false,
        },
        stripeCustomerId: {
          type: 'string' as const,
          required: false,
          input: false,
        },
        subscriptionStatus: {
          type: 'string' as const,
          required: false,
          defaultValue: 'none',
          input: false,
        },
      },
    },
    advanced: {
      useSecureCookies: secureCookies,
      defaultCookieAttributes: {
        sameSite: 'lax' as const,
        secure: secureCookies,
        httpOnly: true,
        path: '/',
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: (user: Record<string, unknown>) => {
            const role = userCount() === 0 ? 'admin' : 'user';
            return Promise.resolve({ data: { ...user, role } });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(ctx => {
        if (ctx.path !== '/sign-up/email') return Promise.resolve();
        if (signupOpen(userCount(), process.env.BETTER_AUTH_OPEN_SIGNUP)) return Promise.resolve();
        throw new APIError('FORBIDDEN', { message: 'Sign up is closed' });
      }),
    },
    plugins,
  };

  // Migrate before betterAuth() starts. Its constructor checks the schema immediately, and a check
  // that races an empty file logs a false "missing tables" error on every fresh boot.
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  handler = toNodeHandler(auth);

  return {
    auth,
    fromNodeHeaders: (headers: IncomingHttpHeaders) => fromNodeHeaders(headers),
    polar: polar !== null,
    polarWebhooks: Boolean(polar?.webhookSecret),
    passwordReset,
    emailVerification,
    stripe: stripeSettings !== null,
    authDatabaseFile: databaseFile,
    accountUserCount: userCount(),
  };
}
