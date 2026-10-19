import { randomUUID } from 'node:crypto';
import type { SpayonCheckoutRequest, SpayonCredentials } from './spayon-client';

const checkoutHost = (url: URL): boolean =>
  url.protocol === 'https:' &&
  !url.username &&
  !url.password &&
  !url.port &&
  (url.hostname === 'spayon.io' || url.hostname.endsWith('.spayon.io') || url.hostname === 'pay.scoupon.am');

interface PaymentOption {
  id: number;
  method: string;
  originalPrice: number;
  originalCurrency: string;
  priceInProductCurrency: number;
  /** Settlement amount. AMD when the card payment is processed in dram. */
  price?: number | string;
  /** Settlement currency, such as AMD. */
  currency?: string;
}

export interface SpayonBankCheckout {
  url: string;
  /** Amount in AMD the buyer pays, rounded the same way as the provider checkout. */
  amountAmd: number;
  /** AMD for one unit of the charged currency. 421.05 means 1 EUR = 421.05 AMD. */
  exchangeRate: number;
}

/**
 * The HTTP equivalent of Spayon's "Proceed to payment" form. Never follows the bank
 * redirect server-side and never handles card data. The original session keeps its callback.
 */
export async function spayonCardCheckoutUrl(
  checkout: { sessionId: string; url: string },
  expected: SpayonCheckoutRequest,
  environment: SpayonCredentials['environment'],
): Promise<SpayonBankCheckout> {
  const storefront = new URL(checkout.url);
  if (!checkoutHost(storefront)) throw new Error('Invalid Spayon storefront URL');
  const api = environment === 'sandbox' ? '/api/sandbox/public' : '/api/public';
  const headers = {
    Origin: storefront.origin,
    Referer: checkout.url,
    'x-browser-id': randomUUID(),
  };
  const detailsResponse = await fetch(`https://api.spayon.io${api}/session/${encodeURIComponent(checkout.sessionId)}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!detailsResponse.ok) throw new Error(`Spayon card session lookup failed (${detailsResponse.status})`);
  const response = (await detailsResponse.json()) as {
    data?: {
      sessionId?: string;
      orderId?: string;
      status?: string;
      price?: string | number;
      productCurrency?: string;
      blockedAt?: string | null;
      noMethodsAvailable?: boolean;
      defaultPaymentOptionId?: number;
      paymentOptions?: PaymentOption[];
    };
  };
  const session = response.data;
  if (
    !session ||
    session.sessionId !== checkout.sessionId ||
    session.orderId !== expected.order_id ||
    session.status !== 'pending' ||
    session.blockedAt ||
    session.noMethodsAvailable ||
    Number(session.price) !== expected.price ||
    session.productCurrency?.toUpperCase() !== expected.currency.toUpperCase()
  ) {
    throw new Error('Spayon card session does not match the order');
  }
  const options = (session.paymentOptions ?? []).filter(option => ['uni', 'visamaster'].includes(option.method));
  const option =
    options.find(item => item.id === session.defaultPaymentOptionId) ?? (options.length === 1 ? options[0] : null);
  if (
    !option ||
    !Number.isSafeInteger(option.id) ||
    option.id <= 0 ||
    option.originalPrice !== expected.price ||
    option.originalCurrency?.toUpperCase() !== expected.currency.toUpperCase() ||
    option.priceInProductCurrency !== expected.price
  ) {
    throw new Error('No matching Spayon card option at the agreed price');
  }
  const settlement = amdSettlement(option);
  const bankResponse = await fetch(
    `https://api.spayon.io${api}/payments/bank/sessions/${encodeURIComponent(checkout.sessionId)}`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: expected.email,
        fullName: expected.full_name ?? '',
        userName: '',
        paymentOptionId: String(option.id),
        language: 'en',
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    },
  );
  const location = bankResponse.headers.get('location');
  if (![302, 303, 307, 308].includes(bankResponse.status) || !location) {
    throw new Error(`Spayon did not provide a bank redirect (${bankResponse.status})`);
  }
  return { url: validateSpayonBankUrl(location, environment), ...settlement };
}

/**
 * The provider checkout shows `1 <currency> = <rate> AMD` as
 * `price / priceInProductCurrency`, then displays both figures to two decimals.
 */
function amdSettlement(option: PaymentOption): Pick<SpayonBankCheckout, 'amountAmd' | 'exchangeRate'> {
  const price = finiteNumber(option.price);
  const charged = finiteNumber(option.priceInProductCurrency);
  if (option.currency?.toUpperCase() !== 'AMD' || price === null || charged === null) {
    throw new Error('Spayon card option did not include an AMD amount');
  }
  const amountAmd = displayed(price);
  const exchangeRate = displayed(price / charged);
  if (amountAmd === null || exchangeRate === null) {
    throw new Error('Spayon card option did not include an AMD amount');
  }
  return { amountAmd, exchangeRate };
}

function finiteNumber(value: number | string | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Same rounding as the provider checkout: parseFloat(Number(value).toFixed(2)). */
function displayed(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const shown = Number(value.toFixed(2));
  return Number.isFinite(shown) && shown > 0 ? shown : null;
}

export function validateSpayonBankUrl(location: string, environment: SpayonCredentials['environment']): string {
  const bank = new URL(location);
  const trustedDestination =
    environment === 'production'
      ? bank.hostname === 'epg.unibank.am'
      : checkoutHost(bank) && bank.pathname.startsWith('/sandbox/');
  if (bank.protocol !== 'https:' || bank.username || bank.password || bank.port || !trustedDestination) {
    throw new Error('Unexpected Spayon bank redirect');
  }
  return bank.href;
}
