import { quotedSpayonAmount, resolveSpayonSettings, spayonUrls } from './spayon-config';

it('defaults to a 59 EUR one-time sandbox payment with checkout unavailable', () => {
  expect(resolveSpayonSettings({})).toMatchObject({
    amount: 5900,
    currency: 'EUR',
    environment: 'sandbox',
    credentials: null,
  });
});

it('reduces a 59 EUR price by 55 EUR only for the server-side promo code', () => {
  const settings = resolveSpayonSettings({ SPAYON_PROMO_CODE: 'TEST-4' });
  expect(settings.promo).toEqual({ code: 'TEST-4', discount: 5500 });
  expect(quotedSpayonAmount(settings, ' TEST-4 ')).toBe(400);
  expect(quotedSpayonAmount(settings, undefined)).toBe(5900);
  expect(() => quotedSpayonAmount(settings, 'test-4')).toThrow('Invalid promo code');
  expect(() => resolveSpayonSettings({ SPAYON_PROMO_CODE: 'TEST-4', SPAYON_PROMO_OFF: '59' })).toThrow();
});

it('accepts credentials and preserves exact minor units', () => {
  expect(
    resolveSpayonSettings({ SPAYON_PRICE: '59.99', SPAYON_CLIENT_ID: 'client', SPAYON_CLIENT_SECRET: 'secret' }),
  ).toMatchObject({
    amount: 5999,
    credentials: { clientId: 'client', clientSecret: 'secret', environment: 'sandbox' },
  });
});

it.each([
  { SPAYON_PRICE: '0' },
  { SPAYON_PRICE: '59.001' },
  { SPAYON_PRICE: 'NaN' },
  { SPAYON_ENVIRONMENT: 'typo' },
  { SPAYON_CURRENCY: 'XYZ' },
  { SPAYON_CLIENT_ID: 'client' },
])('rejects invalid or partial configuration %j', env => {
  expect(() => resolveSpayonSettings(env)).toThrow();
});

it('requires HTTPS URLs in production, allows HTTP for sandbox', () => {
  expect(() => spayonUrls({ BETTER_AUTH_URL: 'http://localhost:2785' }, 'production')).toThrow();
  expect(spayonUrls({ BETTER_AUTH_URL: 'http://localhost:2785' }, 'sandbox').callback).toBe(
    'http://localhost:2785/api/account/spayon/webhook',
  );
  expect(
    spayonUrls(
      { BETTER_AUTH_URL: 'https://api.sherlo.example', DASHBOARD_URL: 'https://sherlo.example' },
      'production',
    ),
  ).toEqual({
    callback: 'https://api.sherlo.example/api/account/spayon/webhook',
    back: 'https://sherlo.example/billing',
  });
});

it('sends the Spayon callback to app.sherlo.co when the configured host does not exist', () => {
  expect(
    spayonUrls(
      {
        SPAYON_CALLBACK_URL: 'https://api.sherlo.co/api/account/spayon/webhook',
        SPAYON_RETURN_URL: 'https://app.sherlo.co/billing',
      },
      'production',
    ).callback,
  ).toBe('https://app.sherlo.co/api/account/spayon/webhook');
  expect(
    spayonUrls({ BETTER_AUTH_URL: 'https://api.sherlo.co', DASHBOARD_URL: 'https://app.sherlo.co' }, 'production')
      .callback,
  ).toBe('https://app.sherlo.co/api/account/spayon/webhook');
});

it('supports explicit HTTPS payment URLs while keeping local auth and the dashboard unchanged', () => {
  expect(
    spayonUrls(
      {
        SPAYON_CALLBACK_URL: 'https://payments.example/api/account/spayon/webhook',
        SPAYON_RETURN_URL: 'https://payments.example/billing',
        BETTER_AUTH_URL: 'http://localhost:2785',
        DASHBOARD_URL: 'http://localhost:2886',
      },
      'production',
    ),
  ).toEqual({
    callback: 'https://payments.example/api/account/spayon/webhook',
    back: 'https://payments.example/billing',
  });
  expect(() =>
    spayonUrls(
      { SPAYON_CALLBACK_URL: 'http://localhost/webhook', SPAYON_RETURN_URL: 'https://payments.example/billing' },
      'production',
    ),
  ).toThrow();
});
