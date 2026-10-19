import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestCheckoutOrigin } from './pay-origin';
import { relaxTestCardFormAction } from './pay-test-page';
import { minorUnits, PayService } from './pay.service';

const previous = {
  AUTH_DATABASE_PATH: process.env.AUTH_DATABASE_PATH,
  SPAYON_CLIENT_ID: process.env.SPAYON_CLIENT_ID,
  SPAYON_CLIENT_SECRET: process.env.SPAYON_CLIENT_SECRET,
  SPAYON_ENVIRONMENT: process.env.SPAYON_ENVIRONMENT,
  SPAYON_CURRENCY: process.env.SPAYON_CURRENCY,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('keeps currency units exact down to cents', () => {
  expect(minorUnits(4)).toBe(400);
  expect(minorUnits(4.5)).toBe(450);
  expect(() => minorUnits(4.001)).toThrow(BadRequestException);
  expect(() => minorUnits(0)).toThrow(BadRequestException);
});

it('refuses a customer return URL that is not public HTTPS before contacting the provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sherlo-pay-service-'));
  process.env.AUTH_DATABASE_PATH = join(directory, 'auth.sqlite');
  process.env.SPAYON_CLIENT_ID = 'client';
  process.env.SPAYON_CLIENT_SECRET = 'secret';
  process.env.SPAYON_ENVIRONMENT = 'production';
  process.env.SPAYON_CURRENCY = 'EUR';
  process.env.BETTER_AUTH_URL = 'https://api.sherlo.example';
  const service = new PayService();
  const input = {
    amount: 4,
    productName: 'Other app',
    email: 'buyer@example.com',
    reference: 'order-1',
    returnUrl: 'http://localhost:3000/thanks',
    cancelUrl: 'https://app.example/cancel',
  };
  const live = { test: false, origin: 'https://api.sherlo.co' };
  await expect(service.create(input, live)).rejects.toThrow(BadRequestException);
  await expect(service.create({ ...input, returnUrl: 'https://10.0.0.1/thanks' }, live)).rejects.toThrow(
    BadRequestException,
  );
  rmSync(directory, { recursive: true, force: true });
});

it('lets the test card post on this host and return to the merchant', () => {
  const policy = relaxTestCardFormAction("default-src 'self';form-action 'self';script-src 'self'");
  expect(policy).toContain("form-action 'self' https: http://localhost:* http://127.0.0.1:*");
  expect(policy).toContain("script-src 'self'");
});

it('keeps a test card on a Sherlo host', () => {
  expect(requestCheckoutOrigin({ protocol: 'http', get: () => 'api.sherlo.co', headers: {} }, {})).toBe(
    'https://api.sherlo.co',
  );
  expect(
    requestCheckoutOrigin({ protocol: 'http', get: () => 'localhost:2795', headers: {} }, { NODE_ENV: 'development' }),
  ).toBe('http://localhost:2795');
  expect(
    requestCheckoutOrigin(
      { protocol: 'http', get: () => 'evil.example', headers: {} },
      { NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.sherlo.co' },
    ),
  ).toBe('https://app.sherlo.co');
});

it('confirms a test checkout on Sherlo’s card page without calling the bank', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sherlo-pay-test-'));
  process.env.AUTH_DATABASE_PATH = join(directory, 'auth.sqlite');
  delete process.env.SPAYON_CLIENT_ID;
  delete process.env.SPAYON_CLIENT_SECRET;
  process.env.SPAYON_ENVIRONMENT = 'production';
  process.env.SPAYON_CURRENCY = 'EUR';
  process.env.BETTER_AUTH_URL = 'https://api.sherlo.co';
  const service = new PayService();
  const input = {
    amount: 4,
    productName: 'Other app <b>',
    email: 'buyer@example.com',
    reference: 'order-test',
    returnUrl: 'https://app.example/thanks',
    cancelUrl: 'https://app.example/cancel',
  };
  const created = await service.create(input, { test: true, origin: 'http://api.sherlo.co' });
  expect(created).toMatchObject({ status: 'pending', amount: 4, currency: 'EUR', amountAmd: 1600, exchangeRate: 400 });
  expect(created.url).toMatch(/^https:\/\/api\.sherlo\.co\/api\/pay\/test\/[0-9a-f-]+\?t=/);
  expect((await service.create(input, { test: true, origin: 'https://api.sherlo.co' })).url).toBe(created.url);
  expect(() => service.find(created.id, false)).toThrow(NotFoundException);

  const token = new URL(created.url!).searchParams.get('t') ?? '';
  const page = service.testCheckout(created.id, token);
  expect(page).toMatchObject({ action: 'html', status: 200 });
  if (page?.action === 'html') {
    expect(page.html).toContain('Payer');
    expect(page.html).toContain('Sherlo Pro');
    expect(page.html).not.toContain('Other app');
    expect(page.html).toContain(`action="/api/pay/test/${created.id}?t=`);
    expect(page.html).not.toContain('https://app.sherlo.co');
    expect(page.html).not.toMatch(/<input[^>]*\sname=/);
  }
  const paid = service.completeTestCheckout(created.id, token);
  expect(paid?.action).toBe('redirect');
  if (paid?.action === 'redirect') {
    const back = new URL(paid.location);
    expect(`${back.origin}${back.pathname}`).toBe('https://app.example/thanks');
    expect(back.searchParams.get('payment')).toBe(created.id);
    expect(back.searchParams.get('reference')).toBe('order-test');
  }
  expect(service.buyerHandoff(created.id, 'return')).toContain('https://app.example/thanks');
  expect(service.buyerHandoff(created.id, 'cancel')).toContain('https://app.example/cancel');
  expect(service.find(created.id, true)).toMatchObject({ status: 'paid', url: null, amountAmd: 1600 });
  expect(service.completeTestCheckout(created.id, 'nope')).toBeNull();
  rmSync(directory, { recursive: true, force: true });
});

it('never gives Spayon the application address or product title', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sherlo-pay-proxy-'));
  process.env.AUTH_DATABASE_PATH = join(directory, 'auth.sqlite');
  process.env.SPAYON_CLIENT_ID = 'client';
  process.env.SPAYON_CLIENT_SECRET = 'secret';
  process.env.SPAYON_ENVIRONMENT = 'sandbox';
  process.env.SPAYON_CURRENCY = 'EUR';
  process.env.BETTER_AUTH_URL = 'https://api.sherlo.co';
  const seen: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (typeof init?.body === 'string' && init.body.startsWith('{')) seen.push(JSON.parse(init.body));
    if (url.includes('/tokens')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (init?.method === 'POST' && url.includes('checkout-session')) {
      return new Response(
        JSON.stringify({ session_id: 'sess-1', session_url: 'https://pay.spayon.io/sandbox/session/sess-1' }),
        { status: 200 },
      );
    }
    return new Response('stop', { status: 500 });
  }) as typeof fetch;
  try {
    const service = new PayService();
    await expect(
      service.create(
        {
          amount: 49.99,
          productName: 'Basic Pass secret',
          email: 'buyer@example.com',
          reference: 'order-proxy',
          returnUrl: 'https://basic-pass.com/compte/',
          cancelUrl: 'https://basic-pass.com/compte/?arcapay=cancel',
        },
        { test: false, origin: 'https://basic-pass.com' },
      ),
    ).rejects.toThrow();
    const payload = seen.find(body => typeof body.product_name === 'string');
    const encoded = JSON.stringify(payload);
    const handoff = /^https:\/\/api\.sherlo\.co\/api\/pay\/r\/[0-9a-f]{32}$/;
    expect(payload?.product_name).toBe('Sherlo Pro');
    expect(String(payload?.return_url)).toMatch(handoff);
    expect(String(payload?.cancel_url)).toMatch(handoff);
    expect(payload?.return_url).not.toBe(payload?.cancel_url);
    expect(encoded).not.toContain('basic-pass.com');
    expect(encoded).not.toContain('Basic Pass');
  } finally {
    globalThis.fetch = original;
    rmSync(directory, { recursive: true, force: true });
  }
});
