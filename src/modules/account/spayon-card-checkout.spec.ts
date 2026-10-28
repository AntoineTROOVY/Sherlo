import { spayonCardCheckoutUrl } from './spayon-card-checkout';
import type { SpayonCheckoutRequest } from './spayon-client';

const checkout = { sessionId: 's-1', url: 'https://pay.scoupon.am/session/s-1' };
const expected: SpayonCheckoutRequest = {
  product_name: 'Sherlo Pro',
  price: 59,
  currency: 'EUR',
  order_id: 'order-1',
  email: 'customer@example.com',
  full_name: 'Customer',
  defaultPaymentMethod: 'visamaster',
  callback_url: 'https://sherlo.example/webhook',
  return_url: 'https://sherlo.example/billing',
  cancel_url: 'https://sherlo.example/billing',
};
const card = {
  id: 2558,
  method: 'uni',
  originalPrice: 59,
  originalCurrency: 'EUR',
  priceInProductCurrency: 59,
  price: 24780,
  currency: 'AMD',
};
const settlement = { amountAmd: 24780, exchangeRate: 420 };
const session = {
  sessionId: 's-1',
  orderId: 'order-1',
  status: 'pending',
  price: '59.00',
  productCurrency: 'EUR',
  defaultPaymentOptionId: 2558,
  paymentOptions: [card],
};
const bank = 'https://epg.unibank.am/epg/merchants/SCOUPON/payment.html?mdOrder=bank-order&language=en';
const originalFetch = global.fetch;
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
beforeEach(() => {
  global.fetch = fetchMock;
  fetchMock.mockReset();
});
afterAll(() => {
  global.fetch = originalFetch;
});

it('submits the provider form server-side and returns the bank URL without opening it', async () => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ data: session }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: bank } }));
  await expect(spayonCardCheckoutUrl(checkout, expected, 'production')).resolves.toEqual({ url: bank, ...settlement });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][0]).toBe('https://api.spayon.io/api/public/session/s-1');
  const [, init] = fetchMock.mock.calls[1];
  expect(init?.redirect).toBe('manual');
  expect(init?.headers).toMatchObject({
    Origin: 'https://pay.scoupon.am',
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  expect(init?.headers).not.toHaveProperty('Authorization');
  expect(Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams))).toEqual({
    email: expected.email,
    fullName: 'Customer',
    userName: '',
    language: 'en',
    paymentOptionId: '2558',
  });
});

it.each([
  { orderId: 'someone-else' },
  { sessionId: 'someone-else' },
  { status: 'paid' },
  { price: '0.59' },
  { productCurrency: 'AMD' },
  { blockedAt: '2026-01-01' },
  { noMethodsAvailable: true },
])('rejects a mismatched or unavailable session before initiating payment: %j', change => {
  fetchMock.mockResolvedValueOnce(Response.json({ data: { ...session, ...change } }));
  return expect(spayonCardCheckoutUrl(checkout, expected, 'production')).rejects.toThrow('does not match');
});

it('reports the AMD amount and the rate shown on the provider checkout', async () => {
  fetchMock
    .mockResolvedValueOnce(
      Response.json({ data: { ...session, paymentOptions: [{ ...card, price: '24780.50', currency: 'amd' }] } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: bank } }));
  await expect(spayonCardCheckoutUrl(checkout, expected, 'production')).resolves.toEqual({
    url: bank,
    amountAmd: 24780.5,
    exchangeRate: 420.01,
  });
});

it('returns the Telr bank page for a Safon checkout settled in AED', async () => {
  const telr = 'https://secure.telr.com/gateway/process.html?o=bank-order';
  const safon = { sessionId: 's-1', url: 'https://pay.safon.io/session/s-1' };
  fetchMock
    .mockResolvedValueOnce(
      Response.json({
        data: {
          ...session,
          paymentOptions: [{ ...card, method: 'telr', price: 245.99, currency: 'AED' }],
        },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: telr } }));
  await expect(spayonCardCheckoutUrl(safon, expected, 'production')).resolves.toEqual({
    url: telr,
    amountAmd: 245.99,
    exchangeRate: 4.17,
  });
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Origin: 'https://pay.safon.io' } });
});

it.each([{ price: undefined }, { currency: 'EUR' }, { price: 0 }])(
  'refuses a card option that does not give a settlement amount: %j',
  change => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { ...session, paymentOptions: [{ ...card, ...change }] } }));
    return expect(spayonCardCheckoutUrl(checkout, expected, 'production')).rejects.toThrow('settlement amount');
  },
);

it.each([{ originalPrice: 60 }, { originalCurrency: 'AMD' }, { priceInProductCurrency: 60 }, { method: 'crypto' }])(
  'refuses incorrect prices, additional fees or a different payment method: %j',
  change => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: { ...session, paymentOptions: [{ ...card, ...change }] } }));
    return expect(spayonCardCheckoutUrl(checkout, expected, 'production')).rejects.toThrow('No matching');
  },
);

it.each([
  'https://epg.unibank.am.evil.example/payment',
  'http://epg.unibank.am/payment',
  'https://login:secret@epg.unibank.am/payment',
  'https://epg.unibank.am:444/payment',
  'https://localhost/payment',
  'https://pay.scoupon.am/session/s-1',
  'https://secure.telr.com.evil.example/gateway/process.html',
  'http://secure.telr.com/gateway/process.html',
])('refuses unsafe or intermediate redirects: %s', location => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ data: session }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
  return expect(spayonCardCheckoutUrl(checkout, expected, 'production')).rejects.toThrow('Unexpected');
});

it('refuses an unexpected provider response instead of silently returning the intermediate page', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ data: session })).mockResolvedValueOnce(Response.json({}));
  await expect(spayonCardCheckoutUrl(checkout, expected, 'production')).rejects.toThrow('did not provide');
});

it('uses isolated sandbox endpoints and only accepts a sandbox card form', async () => {
  const sandboxUrl = 'https://pay.spayon.io/sandbox/en/card-entry?orderId=bank-order';
  fetchMock
    .mockResolvedValueOnce(Response.json({ data: session }))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: sandboxUrl } }));
  await expect(spayonCardCheckoutUrl(checkout, expected, 'sandbox')).resolves.toEqual({
    url: sandboxUrl,
    ...settlement,
  });
  expect(fetchMock.mock.calls[0][0]).toBe('https://api.spayon.io/api/sandbox/public/session/s-1');
});
