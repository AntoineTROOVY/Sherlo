export interface StripeSettings {
  secretKey: string;
  webhookSecret: string | null;
  /** Recurring price id (price_...), not the product id (prod_...). */
  priceId: string;
}

export function isActiveStripeSubscriptionStatus(status: string | null | undefined): boolean {
  const normalized = (status ?? '').toLowerCase();
  return normalized === 'active' || normalized === 'trialing';
}

export function resolveStripeSettings(env: NodeJS.ProcessEnv): StripeSettings | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const priceId = env.STRIPE_PRICE_ID?.trim() ?? '';
  if (!secretKey || !priceId) return null;
  return {
    secretKey,
    priceId,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() || null,
  };
}
