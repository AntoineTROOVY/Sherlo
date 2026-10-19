import { resolveSpayonSettings } from './spayon-config';
import { spayonAccessUntil } from './spayon-store';
import { resolveTrialDays, trialActive, trialDaysRemaining } from './account-trial';

export interface BillingAccessSnapshot {
  billingEnabled: boolean;
  provider?: 'spayon' | null;
  accessUntil?: string | null;
  subscribed: boolean;
  trialDaysTotal: number;
  /** Null when not on trial (subscribed, admin, or billing off). */
  trialDaysRemaining: number | null;
  trialLastDay: boolean;
  paymentRequired: boolean;
}

type BillingUser = {
  id: string;
  role?: string;
  createdAt?: Date | string;
};

export function isBillingExemptApiPath(path: string): boolean {
  const normalized = path.split('?')[0] ?? path;
  return (
    normalized === '/api/auth/validate' ||
    normalized.startsWith('/api/account') ||
    normalized.startsWith('/api/docs') ||
    normalized === '/api/health'
  );
}

export function resolveBillingAccess(user: BillingUser, env: NodeJS.ProcessEnv): Promise<BillingAccessSnapshot> {
  const settings = resolveSpayonSettings(env);
  const provider = 'spayon' as const;
  const trialDaysTotal = resolveTrialDays(env);
  if (user.role === 'admin') {
    return Promise.resolve({
      billingEnabled: true,
      provider,
      subscribed: true,
      accessUntil: null,
      trialDaysTotal,
      trialDaysRemaining: null,
      trialLastDay: false,
      paymentRequired: false,
    });
  }

  const accessUntil = spayonAccessUntil(user.id, settings.environment, env);
  const subscribed = accessUntil !== null && new Date(accessUntil).getTime() > Date.now();
  if (subscribed) {
    return Promise.resolve({
      billingEnabled: true,
      provider,
      subscribed: true,
      accessUntil,
      trialDaysTotal,
      trialDaysRemaining: null,
      trialLastDay: false,
      paymentRequired: false,
    });
  }

  const createdAt = user.createdAt ? new Date(user.createdAt) : new Date();
  const daysLeft = trialDaysRemaining(createdAt, trialDaysTotal);
  const onTrial = trialActive(createdAt, trialDaysTotal);

  return Promise.resolve({
    billingEnabled: true,
    provider,
    subscribed: false,
    trialDaysTotal,
    trialDaysRemaining: onTrial ? daysLeft : 0,
    trialLastDay: onTrial && daysLeft === 1,
    paymentRequired: !onTrial,
  });
}
