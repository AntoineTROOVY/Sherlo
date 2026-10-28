import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SpayonCredentials {
  clientId: string;
  clientSecret: string;
  environment: 'sandbox' | 'production';
}

export type SpayonPaymentStatus = 'paid' | 'pending' | 'failed' | 'expired';

export interface SpayonSessionStatus {
  sessionId: string;
  orderId: string;
  status: SpayonPaymentStatus;
  price: string | number;
  currency: string;
  /** Present when Spayon reports the moment the session last changed, including expiry. */
  updatedAt?: string;
}

export interface SpayonCheckoutRequest {
  product_name: string;
  /** Exact price in currency units, not cents. */
  price: number;
  currency: string;
  order_id: string;
  callback_url: string;
  return_url: string;
  cancel_url: string;
  email: string;
  full_name?: string;
  /** Ask Spayon to skip its method-selection screen and open card checkout directly. */
  defaultPaymentMethod: 'visamaster';
}

export function verifySpayonSignature(rawBody: string | Buffer, signature: string | null, secret: string): boolean {
  if (!signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

const CHECKOUT_HOSTS = new Set(['spayon.io', 'pay.scoupon.am', 'pay.safon.io']);

/** Hosts Spayon may return as the checkout page. Telr sessions are served from pay.safon.io. */
export function isSpayonCheckoutHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.endsWith('.spayon.io') || CHECKOUT_HOSTS.has(host);
}

/** Page used when an existing session has to be opened again. New sessions use the URL Spayon returns. */
export function spayonCheckoutUrl(sessionId: string, environment: SpayonCredentials['environment']): string {
  const origin = environment === 'sandbox' ? 'https://pay.spayon.io/sandbox' : 'https://pay.safon.io';
  return `${origin}/session/${encodeURIComponent(sessionId)}`;
}

/** Server-side client for https://docs.spayon.io/. Never expose credentials to the dashboard. */
export class SpayonClient {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(private readonly credentials: SpayonCredentials) {}

  private get sessionPath(): string {
    return this.credentials.environment === 'sandbox' ? '/api/sandbox/vendor/checkout-session' : '/api/product/session';
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`https://api.spayon.io${path}`, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    // Do not include provider bodies: they may contain customer data or credentials.
    if (!response.ok) throw new Error(`Spayon API request failed (${response.status})`);
    return response.json();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const body = (await this.request(
        this.credentials.environment === 'sandbox' ? '/api/sandbox/vendor/tokens' : '/api/tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret }),
        },
      )) as { access_token?: unknown; expires_in?: unknown };
      if (
        typeof body.access_token !== 'string' ||
        !body.access_token ||
        typeof body.expires_in !== 'number' ||
        !Number.isFinite(body.expires_in) ||
        body.expires_in <= 0
      ) {
        throw new Error('Invalid Spayon token response');
      }
      this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(0, body.expires_in - 60) * 1000 };
      return body.access_token;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async createSession(input: SpayonCheckoutRequest): Promise<{ sessionId: string; url: string }> {
    const token = await this.accessToken();
    const result = (await this.request(this.sessionPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    })) as { session_id?: unknown; session_url?: unknown };
    if (typeof result.session_id !== 'string' || !result.session_id || typeof result.session_url !== 'string') {
      throw new Error('Invalid Spayon checkout response');
    }
    const url = new URL(result.session_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !isSpayonCheckoutHost(url.hostname)) {
      throw new Error('Invalid Spayon checkout URL');
    }
    return { sessionId: result.session_id, url: url.href };
  }

  async sessionStatus(sessionId: string): Promise<SpayonSessionStatus> {
    if (!sessionId.trim()) throw new Error('Missing Spayon session ID');
    const token = await this.accessToken();
    const result = (await this.request(`${this.sessionPath}/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })) as Partial<SpayonSessionStatus>;
    if (
      result.sessionId !== sessionId ||
      typeof result.orderId !== 'string' ||
      !['paid', 'pending', 'failed', 'expired'].includes(result.status ?? '') ||
      typeof result.currency !== 'string' ||
      !['string', 'number'].includes(typeof result.price) ||
      !Number.isFinite(Number(result.price)) ||
      Number(result.price) <= 0
    ) {
      throw new Error('Invalid Spayon session status');
    }
    const updatedAt = (result as { updatedAt?: unknown }).updatedAt;
    return {
      ...(result as SpayonSessionStatus),
      updatedAt: typeof updatedAt === 'string' && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : undefined,
    };
  }
}
