import type { BetterAuthPlugin } from 'better-auth';
import { createLogger } from '../../common/services/logger.service';
import { resolveBillingAccess } from './account-billing';
import {
  billingReturnUrl,
  resolveCreateCustomerOnSignUp,
  type PolarProductRef,
  type PolarSettings,
} from './polar-config';

const logger = createLogger('Polar');

export interface CatalogProduct {
  slug: string;
  productId: string;
  name: string;
  description: string | null;
  interval: string | null;
  /** Price in cents, when the plan has a fixed price. */
  amount: number | null;
  currency: string | null;
}

interface ListedProduct {
  id: string;
  name: string;
  description: string | null;
  recurring_interval: string | null;
  prices: Array<{
    amount_type?: string;
    price_amount?: number;
    price_currency?: string;
    is_archived?: boolean;
  }>;
}

/**
 * Checkout, the customer portal, signed webhooks, and a catalog the dashboard can render.
 * Loaded with import() because the Polar packages are ESM-only.
 */
export async function polarPlugins(settings: PolarSettings, env: NodeJS.ProcessEnv): Promise<BetterAuthPlugin[]> {
  const [
    { polar, checkout, portal, webhooks },
    { createPolarCore },
    { listProducts },
    { createAuthEndpoint, sessionMiddleware, APIError },
  ] = await Promise.all([
    import('@polar-sh/better-auth'),
    import('@polar-sh/sdk/2026-10'),
    import('@polar-sh/sdk/2026-10/services/products'),
    import('better-auth/api'),
  ]);

  const client = createPolarCore({
    accessToken: settings.accessToken,
    environment: settings.environment,
  });
  const back = billingReturnUrl(env);

  const catalogFromEnv = (): CatalogProduct[] =>
    (settings.products ?? []).map(ref => toCatalogProduct(ref, undefined));

  const catalog = async (): Promise<CatalogProduct[]> => {
    if (settings.products) {
      try {
        const page = (await listProducts(client)({
          id: settings.products.map(product => product.productId),
          limit: 100,
        })) as { items?: ListedProduct[] };
        const byId = new Map((page.items ?? []).map(product => [product.id, product]));
        return settings.products.map(ref => toCatalogProduct(ref, byId.get(ref.productId)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `Polar listProducts failed (${message}). Serving catalog from POLAR_PRODUCTS — ensure the token has products:read for live prices.`,
        );
        return catalogFromEnv();
      }
    }
    const page = (await listProducts(client)({
      is_recurring: true,
      is_archived: false,
      visibility: ['public'],
      limit: 100,
    })) as { items?: ListedProduct[] };
    return assignSlugs(page.items ?? []);
  };

  const checkoutProducts = async (): Promise<PolarProductRef[]> =>
    (await catalog()).map(product => ({ slug: product.slug, productId: product.productId }));

  if (!settings.webhookSecret) {
    logger.warn('POLAR_WEBHOOK_SECRET is unset. Checkout works; subscription events will not be delivered.');
  }

  const createCustomerOnSignUp = resolveCreateCustomerOnSignUp(env);
  if (!createCustomerOnSignUp) {
    logger.warn(
      'POLAR_CREATE_CUSTOMER_ON_SIGNUP=false — sign-up will not create a Polar customer (checkout may create one later).',
    );
  }

  return [
    polar({
      client,
      createCustomerOnSignUp,
      // Checkout, portal and webhooks are separate plugin factories. Their tuple type does not
      // accept a mixed array, but this is the combination the Polar adapter documents.
      use: [
        checkout({
          products: checkoutProducts,
          successUrl: `${back}?checkout_id={CHECKOUT_ID}`,
          returnUrl: back,
          authenticatedUsersOnly: true,
        }),
        portal({ returnUrl: back }),
        ...(settings.webhookSecret ? [webhooks({ secret: settings.webhookSecret })] : []),
      ] as never,
    }),
    {
      id: 'sherlo-polar-catalog',
      endpoints: {
        polarCatalog: createAuthEndpoint('/polar/catalog', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
          try {
            return ctx.json({ products: await catalog() });
          } catch (error) {
            if (error instanceof APIError) throw error;
            const message = error instanceof Error ? error.message : 'Could not list Polar products';
            logger.error(`Polar catalog failed: ${message}`);
            if (settings.products) {
              return ctx.json({ products: catalogFromEnv(), degraded: true });
            }
            throw new APIError('BAD_GATEWAY', { message: 'Could not list subscription plans' });
          }
        }),
        billingStatus: createAuthEndpoint('/billing/status', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
          const { getSessionFromCtx } = await import('better-auth/api');
          const session = await getSessionFromCtx(ctx);
          const user = session?.user;
          if (!user) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
          const access = await resolveBillingAccess(
            {
              id: user.id,
              role: (user as { role?: string }).role,
              createdAt: user.createdAt,
            },
            env,
          );
          return ctx.json({ ...access, provider: 'polar' as const });
        }),
      },
    },
  ] as BetterAuthPlugin[];
}

function assignSlugs(products: ListedProduct[]): CatalogProduct[] {
  const used = new Set<string>();
  return products.map(product => {
    const base = slugify(product.name) || 'plan';
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return toCatalogProduct({ slug, productId: product.id }, product);
  });
}

function toCatalogProduct(ref: PolarProductRef, product: ListedProduct | undefined): CatalogProduct {
  const price = product?.prices.find(
    item => item.amount_type === 'fixed' && item.is_archived !== true && typeof item.price_amount === 'number',
  );
  return {
    slug: ref.slug,
    productId: ref.productId,
    name: product?.name?.trim() || '',
    description: product?.description ?? null,
    interval: product?.recurring_interval ?? null,
    amount: price?.price_amount ?? null,
    currency: price?.price_currency ?? null,
  };
}

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
