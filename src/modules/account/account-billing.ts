import { resolvePolarSettings } from './polar-config';
import { isActiveStripeSubscriptionStatus, resolveStripeSettings } from './stripe-config';
import { resolveTrialDays, trialActive, trialDaysRemaining } from './account-trial';

export interface BillingAccessSnapshot {
  billingEnabled: boolean;
  provider?: 'stripe' | 'polar' | null;
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
  subscriptionStatus?: string | null;
  stripeCustomerId?: string | null;
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

export async function fetchPolarSubscribed(
  accessToken: string,
  environment: 'production' | 'sandbox',
  externalUserId: string,
): Promise<boolean> {
  try {
    const [{ createPolarCore }, { getStateExternalCustomers }] = await Promise.all([
      import('@polar-sh/sdk/2026-10'),
      import('@polar-sh/sdk/2026-10/services/customers'),
    ]);
    const client = createPolarCore({ accessToken, environment });
    const state = await getStateExternalCustomers(client)(externalUserId);
    const subs = (state as { active_subscriptions?: unknown[] }).active_subscriptions;
    return (subs?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function fetchStripeSubscribed(user: BillingUser, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (isActiveStripeSubscriptionStatus(user.subscriptionStatus)) return true;
  const stripe = resolveStripeSettings(env);
  const customerId = user.stripeCustomerId?.trim();
  if (!stripe || !customerId) return false;
  try {
    const { default: Stripe } = await import('stripe');
    const client = new Stripe(stripe.secretKey);
    const subs = await client.subscriptions.list({ customer: customerId, status: 'all', limit: 5 });
    return subs.data.some(sub => isActiveStripeSubscriptionStatus(sub.status));
  } catch {
    return false;
  }
}

export async function resolveBillingAccess(user: BillingUser, env: NodeJS.ProcessEnv): Promise<BillingAccessSnapshot> {
  const stripe = resolveStripeSettings(env);
  const polar = stripe ? null : resolvePolarSettings(env);
  const provider = stripe ? 'stripe' : polar ? 'polar' : null;
  const trialDaysTotal = resolveTrialDays(env);
  const billingEnabled = provider !== null;

  if (!billingEnabled) {
    return {
      billingEnabled: false,
      provider: null,
      subscribed: false,
      trialDaysTotal,
      trialDaysRemaining: null,
      trialLastDay: false,
      paymentRequired: false,
    };
  }

  if (user.role === 'admin') {
    return {
      billingEnabled: true,
      provider,
      subscribed: true,
      trialDaysTotal,
      trialDaysRemaining: null,
      trialLastDay: false,
      paymentRequired: false,
    };
  }

  const subscribed = stripe
    ? await fetchStripeSubscribed(user, env)
    : await fetchPolarSubscribed(polar!.accessToken, polar!.environment, user.id);
  if (subscribed) {
    return {
      billingEnabled: true,
      provider,
      subscribed: true,
      trialDaysTotal,
      trialDaysRemaining: null,
      trialLastDay: false,
      paymentRequired: false,
    };
  }

  const createdAt = user.createdAt ? new Date(user.createdAt) : new Date();
  const daysLeft = trialDaysRemaining(createdAt, trialDaysTotal);
  const onTrial = trialActive(createdAt, trialDaysTotal);

  return {
    billingEnabled: true,
    provider,
    subscribed: false,
    trialDaysTotal,
    trialDaysRemaining: onTrial ? daysLeft : 0,
    trialLastDay: onTrial && daysLeft === 1,
    paymentRequired: !onTrial,
  };
}
