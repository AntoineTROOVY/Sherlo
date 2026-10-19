import { createHash, timingSafeEqual } from 'node:crypto';
import { resolveBetterAuthBaseURL } from './account-actor';
import { billingReturnUrl } from './polar-config';
import type { SpayonCredentials } from './spayon-client';

export interface SpayonSettings {
  credentials: SpayonCredentials | null;
  environment: 'sandbox' | 'production';
  /** Minor currency units for persistence and the dashboard. */
  amount: number;
  currency: string;
  name: string;
  /** Server-side only. The browser never receives the accepted code. */
  promo: { code: string; discount: number } | null;
}

/** Billing remains enforced even before credentials are installed. */
export function resolveSpayonSettings(env: NodeJS.ProcessEnv): SpayonSettings {
  const environment = env.SPAYON_ENVIRONMENT?.trim().toLowerCase() || 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error('SPAYON_ENVIRONMENT must be sandbox or production');
  }
  const price = env.SPAYON_PRICE?.trim() || '59';
  if (
    !/^\d+(\.\d{1,2})?$/.test(price) ||
    Number(price) <= 0 ||
    !Number.isSafeInteger(Math.round(Number(price) * 100))
  ) {
    throw new Error('SPAYON_PRICE must be a positive price with at most two decimal places');
  }
  const currency = env.SPAYON_CURRENCY?.trim().toUpperCase() || 'EUR';
  if (!['AMD', 'RUB', 'USD', 'EUR', 'GBP'].includes(currency)) {
    throw new Error('Unsupported SPAYON_CURRENCY');
  }
  const clientId = env.SPAYON_CLIENT_ID?.trim();
  const clientSecret = env.SPAYON_CLIENT_SECRET?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('Set both SPAYON_CLIENT_ID and SPAYON_CLIENT_SECRET');
  }
  const amount = Math.round(Number(price) * 100);
  const promoCode = env.SPAYON_PROMO_CODE?.trim() ?? '';
  let promo: SpayonSettings['promo'] = null;
  if (promoCode) {
    const off = env.SPAYON_PROMO_OFF?.trim() || '55';
    if (!/^\d+(\.\d{1,2})?$/.test(off) || !Number.isSafeInteger(Math.round(Number(off) * 100))) {
      throw new Error('SPAYON_PROMO_OFF must be a positive amount with at most two decimal places');
    }
    const discount = Math.round(Number(off) * 100);
    if (discount <= 0 || discount >= amount) {
      throw new Error('SPAYON_PROMO_OFF must leave a positive price');
    }
    promo = { code: promoCode, discount };
  }
  return {
    credentials: clientId && clientSecret ? { clientId, clientSecret, environment } : null,
    environment,
    amount,
    currency,
    name: 'Sherlo Pro',
    promo,
  };
}

/** Price in minor units. A code is checked on the server; the browser cannot choose the discount. */
export function quotedSpayonAmount(settings: SpayonSettings, promoCode: string | undefined): number {
  const code = promoCode?.trim() ?? '';
  if (!code) return settings.amount;
  if (!settings.promo || !sameSecret(code, settings.promo.code)) throw new Error('Invalid promo code');
  return settings.amount - settings.promo.discount;
}

function sameSecret(input: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(input).digest(), createHash('sha256').update(expected).digest());
}

export function spayonUrls(env: NodeJS.ProcessEnv, environment: SpayonSettings['environment']) {
  const callback = env.SPAYON_CALLBACK_URL?.trim() || `${resolveBetterAuthBaseURL(env)}/api/account/spayon/webhook`;
  const back = env.SPAYON_RETURN_URL?.trim() || billingReturnUrl(env);
  for (const value of [callback, back]) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      !['http:', 'https:'].includes(url.protocol) ||
      (environment === 'production' && url.protocol !== 'https:')
    ) {
      throw new Error('Spayon production requires public HTTPS callback and return URLs');
    }
  }
  return { callback, back };
}
