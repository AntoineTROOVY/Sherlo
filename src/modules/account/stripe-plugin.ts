import type { BetterAuthPlugin } from 'better-auth';
import { createLogger } from '../../common/services/logger.service';
import { resolveBillingAccess } from './account-billing';
import { loadAuthUserBillingRow } from './account-billing-user';
import { billingReturnUrl } from './polar-config';
import type { StripeSettings } from './stripe-config';
import {
  resolveStripeUserId,
  syncStripeBillingForUser,
  verifyCheckoutSessionForUser,
} from './stripe-sync';

const logger = createLogger('Stripe');

export async function stripePlugins(settings: StripeSettings, env: NodeJS.ProcessEnv): Promise<BetterAuthPlugin[]> {
  const [{ default: Stripe }, { createAuthEndpoint, sessionMiddleware, APIError, getSessionFromCtx }] =
    await Promise.all([import('stripe'), import('better-auth/api')]);

  const stripe = new Stripe(settings.secretKey);
  const billingBase = billingReturnUrl(env).replace(/\/billing$/, '');

  const loadCatalog = async () => {
    const price = await stripe.prices.retrieve(settings.priceId, { expand: ['product'] });
    const product = typeof price.product === 'object' && price.product !== null ? price.product : null;
    const name = product && 'name' in product && typeof product.name === 'string' ? product.name : '';
    const description =
      product && 'description' in product && typeof product.description === 'string' ? product.description : null;
    return {
      provider: 'stripe' as const,
      products: [
        {
          slug: 'pro',
          name,
          description,
          interval: price.recurring?.interval ?? null,
          amount: price.unit_amount,
          currency: price.currency,
        },
      ],
    };
  };

  if (!settings.webhookSecret) {
    logger.warn('STRIPE_WEBHOOK_SECRET is unset. Checkout works; subscription status will not update automatically.');
  }

  return [
    {
      id: 'sherlo-stripe',
      endpoints: {
        stripeCatalog: createAuthEndpoint('/stripe/catalog', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
          try {
            return ctx.json(await loadCatalog());
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Could not load Stripe price';
            logger.error(`Stripe catalog failed: ${message}`);
            throw new APIError('BAD_GATEWAY', { message: 'Could not load subscription plan from Stripe' });
          }
        }),
        stripeCheckout: createAuthEndpoint(
          '/stripe/checkout',
          { method: 'POST', use: [sessionMiddleware], body: undefined },
          async ctx => {
            const session = await getSessionFromCtx(ctx);
            const user = session?.user;
            if (!user?.email) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });

            const checkout = await stripe.checkout.sessions.create({
              mode: 'subscription',
              allow_promotion_codes: true,
              customer_email: user.email,
              client_reference_id: user.id,
              line_items: [{ price: settings.priceId, quantity: 1 }],
              success_url: `${billingBase}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
              cancel_url: `${billingBase}/billing?checkout=canceled`,
              metadata: { userId: user.id },
              subscription_data: {
                metadata: { userId: user.id },
              },
            });
            if (!checkout.url) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Stripe checkout URL missing' });
            }
            return ctx.json({ url: checkout.url });
          },
        ),
        stripePortal: createAuthEndpoint(
          '/stripe/portal',
          { method: 'POST', use: [sessionMiddleware], body: undefined },
          async ctx => {
            const session = await getSessionFromCtx(ctx);
            const user = session?.user;
            if (!user?.id) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
            const billingRow = loadAuthUserBillingRow(user.id, env);
            const customerId = billingRow?.stripeCustomerId?.trim();
            if (!customerId) {
              throw new APIError('BAD_REQUEST', { message: 'No Stripe customer on this account yet. Subscribe first.' });
            }
            const portal = await stripe.billingPortal.sessions.create({
              customer: customerId,
              return_url: billingReturnUrl(env),
            });
            return ctx.json({ url: portal.url });
          },
        ),
        stripeWebhook: createAuthEndpoint('/stripe/webhook', { method: 'POST', body: undefined }, async ctx => {
          if (!settings.webhookSecret) {
            throw new APIError('SERVICE_UNAVAILABLE', { message: 'Stripe webhooks are not configured' });
          }
          if (!ctx.request) throw new APIError('BAD_REQUEST', { message: 'Missing request' });
          const signature = ctx.request.headers.get('stripe-signature');
          if (!signature) throw new APIError('BAD_REQUEST', { message: 'Missing Stripe signature' });

          const payload = await ctx.request.text();
          let event: import('stripe').Stripe.Event;
          try {
            event = stripe.webhooks.constructEvent(payload, signature, settings.webhookSecret);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid signature';
            logger.warn(`Stripe webhook rejected: ${message}`);
            throw new APIError('BAD_REQUEST', { message: 'Invalid Stripe webhook signature' });
          }

          const adapter = ctx.context.internalAdapter;

          if (event.type === 'checkout.session.completed') {
            const checkoutSession = event.data.object as import('stripe').Stripe.Checkout.Session;
            const customerId =
              typeof checkoutSession.customer === 'string' ? checkoutSession.customer : undefined;
            const userId = resolveStripeUserId(
              checkoutSession.metadata,
              checkoutSession.client_reference_id,
              customerId,
              env,
            );
            if (userId) {
              await syncStripeBillingForUser(adapter, stripe, userId, env, {
                customerId,
                checkoutSession,
              });
              logger.log(`Stripe checkout linked for user ${userId}`);
            } else {
              logger.warn('Stripe checkout.session.completed without a matching Sherlo user');
            }
          }

          if (
            event.type === 'customer.subscription.created' ||
            event.type === 'customer.subscription.updated' ||
            event.type === 'customer.subscription.deleted'
          ) {
            const subscription = event.data.object as import('stripe').Stripe.Subscription;
            const customerId = typeof subscription.customer === 'string' ? subscription.customer : undefined;
            const userId = resolveStripeUserId(subscription.metadata, null, customerId, env);
            const status = event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status;
            if (userId) {
              await syncStripeBillingForUser(adapter, stripe, userId, env, {
                customerId,
                subscription: { ...subscription, status },
              });
              logger.log(`Stripe subscription ${subscription.id} → ${status} for user ${userId}`);
            } else {
              logger.warn(`Stripe subscription event without a matching Sherlo user (${subscription.id})`);
            }
          }

          return ctx.json({ received: true });
        }),
        stripeSync: createAuthEndpoint(
          '/stripe/sync',
          { method: 'POST', use: [sessionMiddleware], body: undefined },
          async ctx => {
            const session = await getSessionFromCtx(ctx);
            const user = session?.user;
            if (!user?.id || !user.email) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });

            let checkoutSessionId = '';
            if (ctx.request) {
              try {
                const body = (await ctx.request.json()) as { sessionId?: string };
                checkoutSessionId = body.sessionId?.trim() ?? '';
              } catch {
                checkoutSessionId = '';
              }
            }

            const adapter = ctx.context.internalAdapter;
            if (checkoutSessionId) {
              const checkout = await verifyCheckoutSessionForUser(stripe, checkoutSessionId, {
                id: user.id,
                email: user.email,
              });
              if (checkout) {
                await syncStripeBillingForUser(adapter, stripe, user.id, env, { checkoutSession: checkout });
              }
            } else {
              const customers = await stripe.customers.list({ email: user.email, limit: 1 });
              const customerId = customers.data[0]?.id;
              if (customerId) {
                await syncStripeBillingForUser(adapter, stripe, user.id, env, { customerId });
              }
            }

            const billingRow = loadAuthUserBillingRow(user.id, env);
            const access = await resolveBillingAccess(
              {
                id: user.id,
                role: billingRow?.role ?? (user as { role?: string }).role,
                createdAt: billingRow?.createdAt ?? user.createdAt,
                subscriptionStatus: billingRow?.subscriptionStatus,
                stripeCustomerId: billingRow?.stripeCustomerId,
              },
              env,
            );
            return ctx.json({ ...access, provider: 'stripe' as const });
          },
        ),
        billingStatus: createAuthEndpoint('/billing/status', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
          const session = await getSessionFromCtx(ctx);
          const user = session?.user;
          if (!user) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
          const billingRow = loadAuthUserBillingRow(user.id, env);
          const access = await resolveBillingAccess(
            {
              id: user.id,
              role: billingRow?.role ?? (user as { role?: string }).role,
              createdAt: billingRow?.createdAt ?? user.createdAt,
              subscriptionStatus: billingRow?.subscriptionStatus,
              stripeCustomerId: billingRow?.stripeCustomerId,
            },
            env,
          );
          return ctx.json({ ...access, provider: 'stripe' as const });
        }),
      },
    },
  ] as BetterAuthPlugin[];
}
