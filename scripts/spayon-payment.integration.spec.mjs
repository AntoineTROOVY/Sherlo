// Run after npm run build: node --test scripts/spayon-payment.integration.spec.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

// Exercise the real Better Auth router, raw webhook body, SQLite persistence and session cookies.
// Only the outbound Spayon API is stubbed; this test never creates a real payment.
test('Spayon checkout, signed callback and return reconciliation through account HTTP routes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sherlo-spayon-http-'));
  const keys = [
    'AUTH_DATABASE_PATH',
    'BETTER_AUTH_URL',
    'DASHBOARD_URL',
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_OPEN_SIGNUP',
    'SPAYON_CLIENT_ID',
    'SPAYON_CLIENT_SECRET',
    'SPAYON_ENVIRONMENT',
    'SPAYON_PRICE',
    'SPAYON_CURRENCY',
    'SPAYON_PROMO_CODE',
    'SPAYON_PROMO_OFF',
    'RESEND_API_KEY',
    'NODE_ENV',
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    AUTH_DATABASE_PATH: join(directory, 'auth.sqlite'),
    BETTER_AUTH_URL: 'http://sherlo.test',
    DASHBOARD_URL: 'http://sherlo.test',
    BETTER_AUTH_SECRET: 'integration-test-secret-at-least-32-characters',
    BETTER_AUTH_OPEN_SIGNUP: 'true',
    SPAYON_CLIENT_ID: 'sandbox-client',
    SPAYON_CLIENT_SECRET: 'sandbox-secret',
    SPAYON_ENVIRONMENT: 'sandbox',
    SPAYON_PRICE: '59',
    SPAYON_CURRENCY: 'EUR',
    SPAYON_PROMO_CODE: 'TEST-4',
    SPAYON_PROMO_OFF: '55',
    NODE_ENV: 'test',
  });
  delete process.env.RESEND_API_KEY;
  const originalFetch = globalThis.fetch;
  const orders = new Map();
  let bankInitializations = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.spayon.io/api/sandbox/public/')) {
      if (init.method === 'POST') {
        bankInitializations++;
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('paymentOptionId'), '7');
        assert.equal(init.redirect, 'manual');
        const sessionId = String(url).split('/').at(-1);
        return new Response(null, {
          status: 302,
          headers: { location: `https://pay.spayon.io/sandbox/en/card-entry?orderId=${sessionId}` },
        });
      }
      const sessionId = String(url).split('/').at(-1);
      const order = orders.get(sessionId);
      return Response.json({
        data: {
          ...order,
          productCurrency: 'EUR',
          defaultPaymentOptionId: 7,
          paymentOptions: [
            {
              id: 7,
              method: 'uni',
              originalPrice: Number(order.price),
              originalCurrency: 'EUR',
              priceInProductCurrency: Number(order.price),
            },
          ],
        },
      });
    }
    assert.ok(String(url).startsWith('https://api.spayon.io/api/sandbox/vendor/'));
    if (String(url).endsWith('/tokens')) return Response.json({ access_token: 'sandbox-token', expires_in: 3600 });
    assert.equal(init.headers.Authorization, 'Bearer sandbox-token');
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.ok(body.price === 59 || body.price === 4);
      assert.equal(body.currency, 'EUR');
      assert.equal(body.callback_url, 'http://sherlo.test/api/account/spayon/webhook');
      assert.equal(body.return_url, 'http://sherlo.test/billing?checkout=returned');
      assert.equal(body.product_id, undefined);
      assert.equal(body.defaultPaymentMethod, 'visamaster');
      const sessionId = `session-${orders.size + 1}`;
      orders.set(sessionId, {
        orderId: body.order_id,
        sessionId,
        status: 'pending',
        price: Number(body.price).toFixed(2),
        currency: 'EUR',
      });
      return Response.json({
        session_id: sessionId,
        session_url: `https://pay.spayon.io/sandbox/session/${sessionId}`,
      });
    }
    return Response.json(orders.get(String(url).split('/').at(-1)));
  };
  try {
    const { startAuth } = await import('../dist/modules/account/auth.js');
    const { auth } = await startAuth();
    const request = (path, { cookie, body, raw, signature, method = 'POST' } = {}) =>
      auth.handler(
        new Request(`http://sherlo.test/api/account${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            ...(cookie ? { cookie, origin: 'http://sherlo.test' } : {}),
            ...(signature ? { 'x-signature': signature } : {}),
          },
          ...(method !== 'GET' ? { body: raw ?? JSON.stringify(body ?? {}) } : {}),
        }),
      );
    const signup = async email => {
      const response = await request('/sign-up/email', {
        body: { email, name: email.split('@')[0], password: 'test-password-123!' },
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
    };
    await signup('admin@example.com');
    const alice = await signup('alice@example.com');
    const bob = await signup('bob@example.com');
    assert.equal((await request('/spayon/checkout')).status, 401);
    assert.equal((await request('/spayon/catalog', { method: 'GET' })).status, 401);
    const checkout = await request('/spayon/checkout', { cookie: alice });
    assert.equal(checkout.status, 200, await checkout.clone().text());
    assert.equal((await checkout.json()).url, 'https://pay.spayon.io/sandbox/en/card-entry?orderId=session-1');
    const resume = await request('/spayon/checkout', { cookie: alice });
    assert.equal(resume.status, 200, await resume.clone().text());
    assert.equal((await resume.json()).url, 'https://pay.spayon.io/sandbox/en/card-entry?orderId=session-1');
    assert.equal(orders.size, 1, 'reopening does not create another Spayon session');
    assert.equal(bankInitializations, 1, 'reopening uses the stored bank URL');
    assert.equal((await request('/spayon/sync', { cookie: bob, body: { sessionId: 'session-1' } })).status, 404);
    const status = async cookie => {
      const response = await request('/billing/status', { cookie, method: 'GET' });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    assert.equal((await status(alice)).subscribed, false);
    const raw = JSON.stringify({ ...orders.get('session-1'), status: 'paid' }, null, 2);
    const sign = body => createHmac('sha256', 'sandbox-secret').update(body).digest('hex');
    assert.equal((await request('/spayon/webhook', { raw, signature: 'a'.repeat(64) })).status, 403);
    assert.equal((await status(alice)).subscribed, false);
    const wrongAmount = JSON.stringify({ ...JSON.parse(raw), price: '0.59' });
    assert.equal((await request('/spayon/webhook', { raw: wrongAmount, signature: sign(wrongAmount) })).status, 400);
    assert.equal((await request('/spayon/webhook', { raw, signature: sign(raw) })).status, 200);
    const activated = await status(alice);
    assert.equal(activated.subscribed, true);
    assert.equal(new Date(activated.accessUntil).getUTCFullYear(), new Date().getUTCFullYear() + 40);
    assert.equal((await request('/spayon/webhook', { raw, signature: sign(raw) })).status, 200);
    assert.equal((await status(alice)).accessUntil, activated.accessUntil);
    assert.equal((await request('/spayon/checkout', { cookie: alice })).status, 409);
    assert.equal((await status(bob)).subscribed, false);
    // Reconcile Bob's payment via the authenticated API if the provider callback is missed.
    assert.equal((await request('/spayon/checkout', { cookie: bob })).status, 200);
    orders.get('session-2').status = 'paid';
    const alreadyPaid = await request('/spayon/checkout', { cookie: bob });
    assert.equal(alreadyPaid.status, 409, await alreadyPaid.clone().text());
    assert.equal(orders.size, 2);
    assert.equal(bankInitializations, 2);
    const synced = await request('/spayon/sync', { cookie: bob, body: { sessionId: 'session-2' } });
    assert.equal(synced.status, 200, await synced.clone().text());
    assert.equal((await synced.json()).subscribed, true);
    assert.equal((await status(bob)).subscribed, true);
    const charlie = await signup('charlie@example.com');
    const concurrent = await Promise.all([
      request('/spayon/checkout', { cookie: charlie }),
      request('/spayon/checkout', { cookie: charlie }),
    ]);
    assert.equal(concurrent[0].status, 200);
    assert.equal(concurrent[1].status, 200);
    assert.equal((await concurrent[0].json()).url, (await concurrent[1].json()).url);
    assert.equal(orders.size, 3, 'concurrent clicks share one session');
    orders.get('session-3').status = 'expired';
    orders.get('session-3').updatedAt = '2026-10-19T09:24:29.670Z';
    const expiredSync = await request('/spayon/sync', { cookie: charlie, body: {} });
    assert.equal(expiredSync.status, 200, await expiredSync.clone().text());
    assert.equal((await expiredSync.json()).expiredAt, '2026-10-19T09:24:29.670Z');
    const renewed = await request('/spayon/checkout', { cookie: charlie });
    assert.equal(renewed.status, 200, await renewed.clone().text());
    assert.equal((await renewed.json()).url, 'https://pay.spayon.io/sandbox/en/card-entry?orderId=session-4');
    assert.equal(orders.size, 4, 'expired sessions can be replaced');
    const dana = await signup('dana@example.com');
    assert.equal((await request('/spayon/checkout', { cookie: dana, body: { promoCode: 'nope' } })).status, 400);
    const quote = await request('/spayon/quote', { cookie: dana, body: { promoCode: 'TEST-4' } });
    assert.equal(quote.status, 200, await quote.clone().text());
    assert.deepEqual(await quote.json(), { amount: 400, currency: 'EUR', discount: 5500 });
    const cheap = await request('/spayon/checkout', { cookie: dana, body: { promoCode: 'TEST-4' } });
    assert.equal(cheap.status, 200, await cheap.clone().text());
    assert.equal([...orders.values()].at(-1).price, '4.00');
    assert.equal(orders.size, 5);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
