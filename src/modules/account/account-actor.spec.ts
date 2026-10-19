import { ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  ACCOUNT_SCOPE_NONE,
  accountAllowedSessions,
  accountUserIdOf,
  authDatabasePath,
  canManagePaymentKeys,
  dashboardRoleForAccount,
  resolveBetterAuthBaseURL,
  resolveBetterAuthSecret,
  resolveTrustedOrigins,
  signupOpen,
  syntheticAccountKey,
} from './account-actor';

describe('signupOpen', () => {
  it('lets the first account be created even when later sign-up is closed', () => {
    expect(signupOpen(0, 'false')).toBe(true);
    expect(signupOpen(0, undefined)).toBe(true);
  });

  it('closes sign-up after the first account unless the flag is exactly true', () => {
    expect(signupOpen(1, undefined)).toBe(false);
    expect(signupOpen(2, 'false')).toBe(false);
    expect(signupOpen(2, ' TRUE ')).toBe(true);
  });
});

describe('resolveBetterAuthSecret', () => {
  it('refuses to boot production without a long random secret', () => {
    expect(() => resolveBetterAuthSecret({ NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveBetterAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: 'short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('accepts a production secret of at least 32 characters and a dev fallback otherwise', () => {
    const secret = 'x'.repeat(32);
    expect(resolveBetterAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: secret })).toBe(secret);
    expect(resolveBetterAuthSecret({ NODE_ENV: 'test' }).length).toBeGreaterThanOrEqual(32);
  });
});

describe('resolveBetterAuthBaseURL', () => {
  it('prefers BETTER_AUTH_URL, then BASE_URL, and strips a trailing slash', () => {
    expect(resolveBetterAuthBaseURL({ BETTER_AUTH_URL: 'https://sherlo.example/', BASE_URL: 'http://other' })).toBe(
      'https://sherlo.example',
    );
    expect(resolveBetterAuthBaseURL({ BASE_URL: 'https://dokploy.example' })).toBe('https://dokploy.example');
    expect(resolveBetterAuthBaseURL({ PORT: '3000' })).toBe('http://localhost:3000');
  });
});

describe('resolveTrustedOrigins', () => {
  it('accepts the dev server when it is started on another port', () => {
    expect(
      resolveTrustedOrigins({ NODE_ENV: 'development', PORT: '2795', DASHBOARD_PORT: '2896' }),
    ).toEqual(
      expect.arrayContaining([
        'http://localhost:2896',
        'http://127.0.0.1:2896',
        'http://localhost:2795',
        'http://localhost:2886',
      ]),
    );
  });

  it('includes the public origin, the dashboard, and explicit CORS origins', () => {
    expect(
      resolveTrustedOrigins({
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'https://sherlo.example',
        DASHBOARD_URL: 'https://app.example',
        CORS_ORIGINS: 'https://app.example, *',
      }),
    ).toEqual(['https://sherlo.example', 'https://app.example']);
  });
});

describe('authDatabasePath', () => {
  it('defaults onto the data volume and honors an override', () => {
    expect(authDatabasePath({})).toBe('./data/auth.sqlite');
    expect(authDatabasePath({ AUTH_DATABASE_PATH: ' /data/auth.sqlite ' })).toBe('/data/auth.sqlite');
  });
});

describe('accountAllowedSessions', () => {
  it('scopes dashboard users to their sessions and blocks wildcard subscribe when empty', () => {
    expect(accountAllowedSessions(['s1', 's2'])).toEqual(['s1', 's2']);
    expect(accountAllowedSessions([])).toEqual([ACCOUNT_SCOPE_NONE]);
  });
});

describe('syntheticAccountKey', () => {
  it('gives each account an explicit session allowlist (never null)', () => {
    const admin = syntheticAccountKey({ id: 'u1', email: 'a@b.c', role: 'admin', sessionIds: ['s1'] });
    expect(admin.role).toBe(ApiKeyRole.ADMIN);
    expect(admin.allowedSessions).toEqual(['s1']);
    expect(accountUserIdOf(admin)).toBe('u1');
    expect(admin.accountEmail).toBe('a@b.c');

    const owner = syntheticAccountKey({
      id: 'pay',
      email: 'Destructor67810@gmail.com',
      role: 'admin',
      sessionIds: [],
    });
    expect(canManagePaymentKeys(owner)).toBe(true);
    expect(canManagePaymentKeys(admin)).toBe(false);
    expect(dashboardRoleForAccount('Destructor67810@gmail.com', 'user')).toBe('admin');
    expect(dashboardRoleForAccount('someone@example.com', 'admin')).toBe('admin');
    expect(dashboardRoleForAccount('someone@example.com', 'user')).toBe('user');
    expect(canManagePaymentKeys({ ...owner, accountUserId: '' } as typeof owner)).toBe(false);

    const member = syntheticAccountKey({ id: 'u2', email: 'c@d.e', role: 'user', sessionIds: ['s2'] });
    expect(member.role).toBe(ApiKeyRole.OPERATOR);
    expect(member.allowedSessions).toEqual(['s2']);

    const empty = syntheticAccountKey({ id: 'u3', email: 'e@f.g', role: 'user', sessionIds: [] });
    expect(empty.allowedSessions).toEqual([ACCOUNT_SCOPE_NONE]);
  });
});
