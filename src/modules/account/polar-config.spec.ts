import { billingReturnUrl, parsePolarProducts, resolvePolarSettings } from './polar-config';

describe('resolvePolarSettings', () => {
  it('leaves billing off when no access token is configured', () => {
    expect(resolvePolarSettings({})).toBeNull();
    expect(resolvePolarSettings({ POLAR_ACCESS_TOKEN: '  ' })).toBeNull();
  });

  it('defaults to production and keeps an explicit sandbox', () => {
    expect(resolvePolarSettings({ POLAR_ACCESS_TOKEN: 'token' })?.environment).toBe('production');
    expect(resolvePolarSettings({ POLAR_ACCESS_TOKEN: 'token', POLAR_ENVIRONMENT: 'sandbox' })?.environment).toBe(
      'sandbox',
    );
  });
});

describe('parsePolarProducts', () => {
  it('reads slug and product id around the first colon', () => {
    expect(
      parsePolarProducts('pro:11111111-1111-1111-1111-111111111111, team:22222222-2222-2222-2222-222222222222'),
    ).toEqual([
      { slug: 'pro', productId: '11111111-1111-1111-1111-111111111111' },
      { slug: 'team', productId: '22222222-2222-2222-2222-222222222222' },
    ]);
  });

  it('treats a blank value as the live catalog and rejects a broken entry', () => {
    expect(parsePolarProducts('  ')).toBeNull();
    expect(() => parsePolarProducts('pro')).toThrow(/POLAR_PRODUCTS/);
  });
});

describe('billingReturnUrl', () => {
  it('prefers the dashboard origin, then the local Vite port outside production', () => {
    expect(billingReturnUrl({ DASHBOARD_URL: 'https://sherlo.example.com/' })).toBe(
      'https://sherlo.example.com/billing',
    );
    expect(billingReturnUrl({ NODE_ENV: 'development' })).toBe('http://localhost:2886/billing');
    expect(billingReturnUrl({ NODE_ENV: 'production', BASE_URL: 'https://sherlo.example.com' })).toBe(
      'https://sherlo.example.com/billing',
    );
  });
});
