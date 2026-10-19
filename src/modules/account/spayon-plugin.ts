import { randomUUID } from 'node:crypto';
import { createLogger } from '../../common/services/logger.service';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';
import { resolveBillingAccess } from './account-billing';
import { loadAuthUserBillingRow } from './account-billing-user';
import { SpayonClient, verifySpayonSignature, type SpayonCheckoutRequest } from './spayon-client';
import { spayonCardCheckoutUrl, validateSpayonBankUrl } from './spayon-card-checkout';
import { quotedSpayonAmount, spayonUrls, type SpayonSettings } from './spayon-config';
import {
  applySpayonPayment,
  attachSpayonSession,
  createSpayonOrder,
  rememberSpayonBankUrl,
  spayonOrderForUser,
} from './spayon-store';
import { applyGatewayPayment } from '../pay/pay-store';
import { issuePaymentHandoff } from '../pay/payment-handoff';

const logger = createLogger('Spayon');

const paymentSchema = z.object({
  sessionId: z.string().min(1).max(200),
  orderId: z.string().uuid(),
  status: z.enum(['paid', 'pending', 'failed', 'expired']),
  price: z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().finite().positive()]),
  currency: z.string().length(3),
});

export async function spayonPlugins(settings: SpayonSettings, env: NodeJS.ProcessEnv): Promise<BetterAuthPlugin[]> {
  const { createAuthEndpoint, sessionMiddleware, APIError, getSessionFromCtx } = await import('better-auth/api');
  const client = settings.credentials ? new SpayonClient(settings.credentials) : null;
  const urls = spayonUrls(env, settings.environment);

  const accessForUser = async (user: { id: string; createdAt: Date; role?: string }) => {
    const row = loadAuthUserBillingRow(user.id, env);
    return resolveBillingAccess(
      {
        id: user.id,
        role: row?.role ?? user.role,
        createdAt: row?.createdAt ?? user.createdAt,
      },
      env,
    );
  };

  const preparing = new Map<string, Promise<{ url: string }>>();
  const prepareCheckout = async (
    user: { id: string; email: string; name: string; createdAt: Date; role?: string },
    promoCode?: string,
  ) => {
    if (!client) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Payment is not configured yet' });
    if ((await accessForUser(user)).subscribed) {
      throw new APIError('CONFLICT', { message: 'Access is already active on this account' });
    }
    let amount: number;
    try {
      amount = quotedSpayonAmount(settings, promoCode);
    } catch {
      throw new APIError('BAD_REQUEST', { message: 'Invalid promo code' });
    }
    const previous = spayonOrderForUser(undefined, user.id, settings.environment, env);
    let resumable =
      previous?.status === 'pending' && previous.sessionId && previous.amount === amount ? previous : null;
    if (resumable?.sessionId) {
      const payment = await client.sessionStatus(resumable.sessionId);
      applySpayonPayment(payment, settings.environment, env);
      if (payment.status === 'paid') {
        throw new APIError('CONFLICT', { message: 'Payment is confirmed. Access is already active.' });
      }
      if (payment.status !== 'pending') resumable = null;
    }
    if (resumable?.bankUrl) {
      return { url: validateSpayonBankUrl(resumable.bankUrl, settings.environment) };
    }
    const orderId = resumable?.id ?? randomUUID();
    const request: SpayonCheckoutRequest = {
      product_name: settings.name,
      price: amount / 100,
      currency: resumable?.currency ?? settings.currency,
      order_id: orderId,
      email: user.email,
      full_name: user.name,
      defaultPaymentMethod: 'visamaster',
      callback_url: urls.callback,
      return_url: issuePaymentHandoff(`${urls.back}?checkout=returned`, env),
      cancel_url: issuePaymentHandoff(`${urls.back}?checkout=canceled`, env),
    };
    let checkout;
    if (resumable?.sessionId) {
      // Older orders predate bank-URL persistence; initialize their existing Spayon session once.
      const origin = settings.environment === 'sandbox' ? 'https://pay.spayon.io/sandbox' : 'https://pay.scoupon.am';
      checkout = {
        sessionId: resumable.sessionId,
        url: `${origin}/session/${encodeURIComponent(resumable.sessionId)}`,
      };
    } else {
      createSpayonOrder(orderId, user.id, settings, env, amount);
      checkout = await client.createSession(request);
      attachSpayonSession(orderId, checkout.sessionId, env);
    }
    const bank = await spayonCardCheckoutUrl(checkout, request, settings.environment);
    rememberSpayonBankUrl(orderId, bank.url, env);
    return { url: bank.url };
  };

  return [
    {
      id: 'sherlo-spayon',
      endpoints: {
        spayonCatalog: createAuthEndpoint('/spayon/catalog', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
          return ctx.json({
            provider: 'spayon',
            checkoutAvailable: client !== null,
            products: [
              {
                slug: 'pro',
                name: settings.name,
                description: null,
                interval: null,
                amount: settings.amount,
                currency: settings.currency,
              },
            ],
          });
        }),
        spayonQuote: createAuthEndpoint(
          '/spayon/quote',
          {
            method: 'POST',
            use: [sessionMiddleware],
            body: z.object({ promoCode: z.string().trim().min(1).max(80) }),
          },
          async ctx => {
            try {
              const amount = quotedSpayonAmount(settings, ctx.body.promoCode);
              return ctx.json({ amount, currency: settings.currency, discount: settings.amount - amount });
            } catch {
              throw new APIError('BAD_REQUEST', { message: 'Invalid promo code' });
            }
          },
        ),
        spayonCheckout: createAuthEndpoint(
          '/spayon/checkout',
          {
            method: 'POST',
            use: [sessionMiddleware],
            body: z.object({ promoCode: z.string().trim().max(80).optional() }),
          },
          async ctx => {
            const session = await getSessionFromCtx(ctx);
            if (!session?.user?.email) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
            const preparationKey = `${session.user.id}:${ctx.body.promoCode?.trim() ?? ''}`;
            let preparation = preparing.get(preparationKey);
            if (!preparation) {
              preparation = prepareCheckout(session.user, ctx.body.promoCode);
              preparing.set(preparationKey, preparation);
            }
            try {
              return ctx.json(await preparation);
            } catch (error) {
              if (error instanceof APIError) throw error;
              logger.error(`Checkout preparation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
              throw new APIError('BAD_GATEWAY', { message: 'Could not open the payment. Please try again.' });
            } finally {
              if (preparing.get(preparationKey) === preparation) preparing.delete(preparationKey);
            }
          },
        ),
        spayonWebhook: createAuthEndpoint(
          '/spayon/webhook',
          {
            method: 'POST',
            disableBody: true,
          },
          async ctx => {
            if (!settings.credentials)
              throw new APIError('SERVICE_UNAVAILABLE', { message: 'Payment is not configured yet' });
            if (!ctx.request) throw new APIError('BAD_REQUEST', { message: 'Missing request' });
            const raw = Buffer.from(await ctx.request.arrayBuffer());
            if (raw.length > 65_536) throw new APIError('BAD_REQUEST', { message: 'Callback too large' });
            if (
              !verifySpayonSignature(raw, ctx.request.headers.get('x-signature'), settings.credentials.clientSecret)
            ) {
              throw new APIError('FORBIDDEN', { message: 'Invalid payment signature' });
            }
            let payment;
            try {
              payment = paymentSchema.parse(JSON.parse(raw.toString('utf8')));
            } catch {
              throw new APIError('BAD_REQUEST', { message: 'Invalid payment callback' });
            }
            try {
              applySpayonPayment(payment, settings.environment, env);
            } catch {
              let gatewayId: string | null = null;
              try {
                gatewayId = applyGatewayPayment(payment, settings.environment, env);
              } catch {
                gatewayId = null;
              }
              if (!gatewayId) throw new APIError('BAD_REQUEST', { message: 'Payment does not match an order' });
            }
            return ctx.json({ received: true });
          },
        ),
        spayonSync: createAuthEndpoint(
          '/spayon/sync',
          {
            method: 'POST',
            use: [sessionMiddleware],
            body: z.object({ sessionId: z.string().min(1).max(200).optional() }),
          },
          async ctx => {
            const session = await getSessionFromCtx(ctx);
            if (!session?.user) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
            const order = spayonOrderForUser(ctx.body.sessionId, session.user.id, settings.environment, env);
            if (ctx.body.sessionId && !order) throw new APIError('NOT_FOUND', { message: 'Payment not found' });
            let paymentStatus = order?.status ?? null;
            let expiredAt = order?.expiredAt ?? null;
            if (order?.sessionId && order.status !== 'paid' && (order.status === 'pending' || ctx.body.sessionId)) {
              if (!client) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Payment is not configured yet' });
              try {
                const payment = await client.sessionStatus(order.sessionId);
                applySpayonPayment(payment, settings.environment, env);
                paymentStatus = payment.status;
                expiredAt =
                  spayonOrderForUser(order.sessionId, session.user.id, settings.environment, env)?.expiredAt ?? null;
              } catch {
                throw new APIError('BAD_GATEWAY', { message: 'Could not verify the payment. Please try again.' });
              }
            }
            return ctx.json({ ...(await accessForUser(session.user)), paymentStatus, expiredAt });
          },
        ),
        billingStatus: createAuthEndpoint('/billing/status', { method: 'GET', use: [sessionMiddleware] }, async ctx => {
          const session = await getSessionFromCtx(ctx);
          if (!session?.user) throw new APIError('UNAUTHORIZED', { message: 'Unauthorized' });
          return ctx.json(await accessForUser(session.user));
        }),
      },
    },
  ];
}
