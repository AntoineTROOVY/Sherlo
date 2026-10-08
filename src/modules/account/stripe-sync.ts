import type Stripe from 'stripe';
import { findAuthUserIdByStripeCustomerId } from './account-billing-user';
import { isActiveStripeSubscriptionStatus } from './stripe-config';

type UserAdapter = {
  updateUser: (userId: string, data: Record<string, unknown>) => Promise<unknown>;
};

export function resolveStripeUserId(
  metadata: Stripe.Metadata | null | undefined,
  clientReferenceId: string | null | undefined,
  customerId: string | null | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const fromMeta = metadata?.userId?.trim();
  if (fromMeta) return fromMeta;
  const fromRef = clientReferenceId?.trim();
  if (fromRef) return fromRef;
  if (customerId?.trim()) {
    const linked = findAuthUserIdByStripeCustomerId(customerId, env);
    if (linked) return linked;
  }
  return '';
}

async function subscriptionStatusForCustomer(
  stripe: Stripe,
  customerId: string,
): Promise<{ status: string | null; subscriptionId: string | null }> {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
  const active = subs.data.find(sub => isActiveStripeSubscriptionStatus(sub.status));
  if (active) return { status: active.status, subscriptionId: active.id };
  const latest = subs.data[0];
  return { status: latest?.status ?? null, subscriptionId: latest?.id ?? null };
}

export async function syncStripeBillingForUser(
  adapter: UserAdapter,
  stripe: Stripe,
  userId: string,
  env: NodeJS.ProcessEnv,
  hints: {
    customerId?: string | null;
    checkoutSession?: Stripe.Checkout.Session;
    subscription?: Stripe.Subscription;
  },
): Promise<{ updated: boolean; subscribed: boolean }> {
  let customerId = hints.customerId?.trim() || '';
  let status: string | null = hints.subscription?.status ?? null;

  const checkout = hints.checkoutSession;
  if (checkout) {
    if (!customerId && typeof checkout.customer === 'string') customerId = checkout.customer;
    if (!status && checkout.subscription) {
      if (typeof checkout.subscription === 'string') {
        const sub = await stripe.subscriptions.retrieve(checkout.subscription);
        status = sub.status;
        if (!customerId && typeof sub.customer === 'string') customerId = sub.customer;
      } else {
        status = checkout.subscription.status;
        if (!customerId && typeof checkout.subscription.customer === 'string') {
          customerId = checkout.subscription.customer;
        }
      }
    }
  }

  if (hints.subscription) {
    if (!status) status = hints.subscription.status;
    if (!customerId && typeof hints.subscription.customer === 'string') {
      customerId = hints.subscription.customer;
    }
  }

  if (!status && customerId) {
    const resolved = await subscriptionStatusForCustomer(stripe, customerId);
    status = resolved.status;
  }

  const patch: Record<string, string> = {};
  if (customerId) patch.stripeCustomerId = customerId;
  if (status) patch.subscriptionStatus = status;

  if (Object.keys(patch).length === 0) {
    return { updated: false, subscribed: false };
  }

  await adapter.updateUser(userId, patch);
  return { updated: true, subscribed: isActiveStripeSubscriptionStatus(status) };
}

export async function verifyCheckoutSessionForUser(
  stripe: Stripe,
  sessionId: string,
  user: { id: string; email: string },
): Promise<Stripe.Checkout.Session | null> {
  const checkout = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'customer'],
  });
  if (checkout.status !== 'complete') return null;

  const ref = checkout.client_reference_id?.trim();
  const metaUser = checkout.metadata?.userId?.trim();
  if (ref && ref !== user.id) return null;
  if (metaUser && metaUser !== user.id) return null;
  if (!ref && !metaUser) {
    const email = checkout.customer_email?.trim().toLowerCase();
    if (!email || email !== user.email.trim().toLowerCase()) return null;
  }
  return checkout;
}
