import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { resolveSpayonSettings } from './spayon-config';
import { resolveBillingAccess } from './account-billing';
import {
  initializeSpayonStore,
  createSpayonOrder,
  attachSpayonSession,
  applySpayonPayment,
  spayonAccessUntil,
  spayonOrderForUser,
  rememberSpayonBankUrl,
} from './spayon-store';

let directory: string;
let env: NodeJS.ProcessEnv;
const payment = {
  sessionId: 'session-1',
  orderId: 'order-1',
  status: 'paid' as const,
  price: '59.00',
  currency: 'EUR',
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sherlo-spayon-'));
  env = { AUTH_DATABASE_PATH: join(directory, 'auth.sqlite'), SPAYON_ENVIRONMENT: 'sandbox' };
  const db = new Database(env.AUTH_DATABASE_PATH!);
  db.exec(`CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES ('alice'), ('bob');`);
  initializeSpayonStore(db);
  db.close();
  createSpayonOrder('order-1', 'alice', resolveSpayonSettings(env), env);
  attachSpayonSession('order-1', 'session-1', env);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('grants exactly 40 calendar years and persists access across connections', async () => {
  applySpayonPayment(payment, 'sandbox', env, new Date('2026-10-19T12:00:00Z'));
  expect(spayonAccessUntil('alice', 'sandbox', env)).toBe('2066-10-19T12:00:00.000Z');
  const result = await resolveBillingAccess({ id: 'alice', createdAt: '2020-01-01' }, env);
  expect(result).toMatchObject({ subscribed: true, paymentRequired: false, provider: 'spayon' });
});

it('does not extend access on duplicate notifications or revoke it after a late failure', () => {
  applySpayonPayment(payment, 'sandbox', env, new Date('2026-01-01Z'));
  applySpayonPayment(payment, 'sandbox', env, new Date('2027-01-01Z'));
  applySpayonPayment({ ...payment, status: 'failed' }, 'sandbox', env);
  expect(spayonAccessUntil('alice', 'sandbox', env)).toBe('2066-01-01T00:00:00.000Z');
});

it.each([{ price: '0.59' }, { price: '59.001' }, { currency: 'AMD' }, { orderId: 'other' }, { sessionId: 'other' }])(
  'rejects a mismatched order, session, amount or currency: %j',
  change => {
    expect(() => applySpayonPayment({ ...payment, ...change }, 'sandbox', env)).toThrow();
    expect(spayonAccessUntil('alice', 'sandbox', env)).toBeNull();
  },
);

it('never grants access for pending, failed or expired payments', () => {
  for (const status of ['pending', 'failed', 'expired'] as const) {
    applySpayonPayment({ ...payment, status }, 'sandbox', env);
    expect(spayonAccessUntil('alice', 'sandbox', env)).toBeNull();
  }
});

it('handles a confirmed payment after a failed attempt', () => {
  applySpayonPayment({ ...payment, status: 'failed' }, 'sandbox', env);
  applySpayonPayment(payment, 'sandbox', env);
  expect(spayonAccessUntil('alice', 'sandbox', env)).not.toBeNull();
});

it('isolates users and sandbox from production', async () => {
  applySpayonPayment(payment, 'sandbox', env);
  expect(spayonAccessUntil('bob', 'sandbox', env)).toBeNull();
  expect(spayonAccessUntil('alice', 'production', env)).toBeNull();
  expect(spayonOrderForUser('session-1', 'bob', 'sandbox', env)).toBeNull();
  expect(spayonOrderForUser('session-1', 'alice', 'production', env)).toBeNull();
  expect(() => applySpayonPayment(payment, 'production', env)).toThrow();
  expect(
    await resolveBillingAccess({ id: 'alice', createdAt: '2020-01-01' }, { ...env, SPAYON_ENVIRONMENT: 'production' }),
  ).toMatchObject({ subscribed: false, paymentRequired: true });
});

it('requires a new payment after the 40-year grant expires', async () => {
  applySpayonPayment(payment, 'sandbox', env, new Date('1980-01-01Z'));
  expect(await resolveBillingAccess({ id: 'alice', createdAt: '2020-01-01' }, env)).toMatchObject({
    subscribed: false,
    paymentRequired: true,
  });
});

it('keeps the trial and admin exemption while enforcing billing without credentials', async () => {
  expect(await resolveBillingAccess({ id: 'alice', createdAt: new Date() }, env)).toMatchObject({
    subscribed: false,
    paymentRequired: false,
    trialDaysTotal: 3,
  });
  expect(await resolveBillingAccess({ id: 'alice', createdAt: '2020-01-01' }, env)).toMatchObject({
    billingEnabled: true,
    paymentRequired: true,
  });
  expect(await resolveBillingAccess({ id: 'bob', role: 'admin' }, env)).toMatchObject({
    subscribed: true,
    accessUntil: null,
    paymentRequired: false,
  });
});

it('records the provider timestamp once when a session expires', () => {
  applySpayonPayment({ ...payment, status: 'expired', updatedAt: '2026-10-19T09:24:29.670Z' }, 'sandbox', env);
  expect(spayonOrderForUser('session-1', 'alice', 'sandbox', env)?.expiredAt).toBe('2026-10-19T09:24:29.670Z');
  applySpayonPayment({ ...payment, status: 'expired', updatedAt: '2027-01-01T00:00:00.000Z' }, 'sandbox', env);
  expect(spayonOrderForUser('session-1', 'alice', 'sandbox', env)?.expiredAt).toBe('2026-10-19T09:24:29.670Z');
  expect(spayonAccessUntil('alice', 'sandbox', env)).toBeNull();
});

it('upgrades existing orders without losing them and persists the resumable bank URL', () => {
  const db = new Database(env.AUTH_DATABASE_PATH!);
  db.exec('ALTER TABLE sherlo_spayon_order DROP COLUMN bankUrl');
  initializeSpayonStore(db);
  initializeSpayonStore(db);
  db.close();
  expect(spayonOrderForUser('session-1', 'alice', 'sandbox', env)).toMatchObject({ id: 'order-1', bankUrl: null });
  rememberSpayonBankUrl('order-1', 'https://pay.spayon.io/sandbox/en/card-entry?orderId=bank-1', env);
  expect(spayonOrderForUser('session-1', 'alice', 'sandbox', env)?.bankUrl).toBe(
    'https://pay.spayon.io/sandbox/en/card-entry?orderId=bank-1',
  );
  expect(spayonOrderForUser('session-1', 'bob', 'sandbox', env)).toBeNull();
});
