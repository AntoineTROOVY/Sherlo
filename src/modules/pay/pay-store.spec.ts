import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  applyGatewayPayment,
  attachGatewaySession,
  gatewayPaymentById,
  initializeGatewayStore,
  insertGatewayPayment,
  markTestPaymentPaid,
} from './pay-store';

let directory: string;
let env: NodeJS.ProcessEnv;
const payment = {
  sessionId: 'session-1',
  orderId: '',
  status: 'paid' as const,
  price: '4.00',
  currency: 'EUR',
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sherlo-pay-'));
  env = { AUTH_DATABASE_PATH: join(directory, 'auth.sqlite') };
  const db = new Database(env.AUTH_DATABASE_PATH!);
  initializeGatewayStore(db);
  db.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('records a paid gateway payment for the calling application to read back', () => {
  const created = insertGatewayPayment(
    {
      reference: 'order-1',
      environment: 'production',
      productName: 'Other app',
      email: 'buyer@example.com',
      fullName: 'Buyer',
      amount: 400,
      currency: 'EUR',
      returnUrl: 'https://app.example/thanks',
      cancelUrl: 'https://app.example/cancel',
    },
    env,
  );
  attachGatewaySession(created.id, 'session-1', 'https://epg.unibank.am/pay', env, {
    amountAmd: 1684.2,
    exchangeRate: 421.05,
  });
  expect(applyGatewayPayment({ ...payment, orderId: created.id }, 'production', env)).toBe(created.id);
  expect(applyGatewayPayment({ ...payment, orderId: created.id }, 'sandbox', env)).toBeNull();
  const stored = gatewayPaymentById(created.id, env);
  expect(stored).toMatchObject({
    status: 'paid',
    amount: 400,
    reference: 'order-1',
    amountAmd: 1684.2,
    exchangeRate: 421.05,
  });
  expect(stored?.paidAt).toEqual(expect.any(String));
});

it('does not let the test page mark a live payment as paid', () => {
  const created = insertGatewayPayment(
    {
      reference: 'order-1',
      environment: 'production',
      productName: 'Other app',
      email: 'buyer@example.com',
      fullName: null,
      amount: 400,
      currency: 'EUR',
      returnUrl: 'https://app.example/thanks',
      cancelUrl: 'https://app.example/cancel',
    },
    env,
  );
  markTestPaymentPaid(created.id, env);
  expect(gatewayPaymentById(created.id, env)?.status).toBe('pending');
});

it('rejects a gateway callback whose amount or session does not match', () => {
  const created = insertGatewayPayment(
    {
      reference: 'order-1',
      environment: 'production',
      productName: 'Other app',
      email: 'buyer@example.com',
      fullName: null,
      amount: 400,
      currency: 'EUR',
      returnUrl: 'https://app.example/thanks',
      cancelUrl: 'https://app.example/cancel',
    },
    env,
  );
  attachGatewaySession(created.id, 'session-1', 'https://epg.unibank.am/pay', env);
  expect(() => applyGatewayPayment({ ...payment, orderId: created.id, price: '59.00' }, 'production', env)).toThrow();
  expect(gatewayPaymentById(created.id, env)?.status).toBe('pending');
});

it('drops a previously stored application callback when opening the store', () => {
  const legacy = new Database(env.AUTH_DATABASE_PATH!);
  legacy.exec('DROP TABLE sherlo_gateway_payment');
  legacy.exec(`CREATE TABLE sherlo_gateway_payment (
    id TEXT PRIMARY KEY, reference TEXT NOT NULL, environment TEXT NOT NULL,
    productName TEXT NOT NULL, email TEXT NOT NULL, fullName TEXT, amount INTEGER NOT NULL,
    currency TEXT NOT NULL, sessionId TEXT UNIQUE, bankUrl TEXT, status TEXT NOT NULL,
    returnUrl TEXT NOT NULL, cancelUrl TEXT NOT NULL, callbackUrl TEXT NOT NULL,
    callbackSecret TEXT NOT NULL, createdAt TEXT NOT NULL, paidAt TEXT, expiredAt TEXT
  )`);
  legacy.close();
  const db = new Database(env.AUTH_DATABASE_PATH!);
  initializeGatewayStore(db);
  const columns = db.prepare('PRAGMA table_info(sherlo_gateway_payment)').all() as Array<{ name: string }>;
  db.close();
  expect(columns.map(column => column.name)).not.toContain('callbackUrl');
  expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['amountAmd', 'exchangeRate']));
});

it('marks the moment a gateway session expires', () => {
  const created = insertGatewayPayment(
    {
      reference: 'order-1',
      environment: 'production',
      productName: 'Other app',
      email: 'buyer@example.com',
      fullName: null,
      amount: 400,
      currency: 'EUR',
      returnUrl: 'https://app.example/thanks',
      cancelUrl: 'https://app.example/cancel',
    },
    env,
  );
  attachGatewaySession(created.id, 'session-1', 'https://epg.unibank.am/pay', env);
  applyGatewayPayment(
    { ...payment, orderId: created.id, status: 'expired', updatedAt: '2026-10-19T09:40:00.000Z' },
    'production',
    env,
  );
  expect(gatewayPaymentById(created.id, env)).toMatchObject({
    status: 'expired',
    paidAt: null,
    expiredAt: '2026-10-19T09:40:00.000Z',
  });
});
