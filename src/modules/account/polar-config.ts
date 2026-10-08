export interface PolarProductRef {
  slug: string;
  productId: string;
}

export interface PolarSettings {
  accessToken: string;
  webhookSecret: string | null;
  environment: 'production' | 'sandbox';
  /** Set when POLAR_PRODUCTS names the plans. Null means the live recurring catalog. */
  products: PolarProductRef[] | null;
}

/**
 * Polar stays off until an organization access token is present, so a local boot
 * without billing credentials still signs accounts in.
 */
export function resolvePolarSettings(env: NodeJS.ProcessEnv): PolarSettings | null {
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim() ?? '';
  if (!accessToken) return null;
  const environment = env.POLAR_ENVIRONMENT?.trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim() || null;
  return {
    accessToken,
    webhookSecret,
    environment,
    products: parsePolarProducts(env.POLAR_PRODUCTS),
  };
}

/** `slug:productId` pairs, comma-separated. A blank value means "ask Polar for the catalog". */
export function parsePolarProducts(raw: string | undefined): PolarProductRef[] | null {
  const text = raw?.trim() ?? '';
  if (!text) return null;
  const products: PolarProductRef[] = [];
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const split = entry.indexOf(':');
    const slug = split === -1 ? '' : entry.slice(0, split).trim();
    const productId = split === -1 ? '' : entry.slice(split + 1).trim();
    if (!slug || !productId) {
      throw new Error(
        'POLAR_PRODUCTS entries must be slug:productId, for example pro:00000000-0000-0000-0000-000000000000',
      );
    }
    products.push({ slug, productId });
  }
  return products.length > 0 ? products : null;
}

/** Polar org tokens need customers:read and customers:write or sign-up fails when this is true. */
export function resolveCreateCustomerOnSignUp(env: NodeJS.ProcessEnv): boolean {
  return env.POLAR_CREATE_CUSTOMER_ON_SIGNUP?.trim().toLowerCase() !== 'false';
}

/** Where Polar sends the customer after checkout. Dev uses the Vite origin; production uses the public URL. */
export function billingReturnUrl(env: NodeJS.ProcessEnv): string {
  const dashboard = env.DASHBOARD_URL?.trim();
  if (dashboard) return `${dashboard.replace(/\/$/, '')}/billing`;
  if (env.NODE_ENV !== 'production') return 'http://localhost:2886/billing';
  const base = (env.BETTER_AUTH_URL?.trim() || env.BASE_URL?.trim() || 'http://localhost:2785').replace(/\/$/, '');
  return `${base}/billing`;
}
