/// <reference path="../account/better-sqlite3.d.ts" />
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { authDatabasePath } from '../account/account-actor';
import type { SpayonSessionStatus } from '../account/spayon-client';

export interface GatewayPayment {
  id: string;
  reference: string;
  environment: string;
  productName: string;
  email: string;
  fullName: string | null;
  /** Minor currency units. */
  amount: number;
  currency: string;
  sessionId: string | null;
  bankUrl: string | null;
  status: string;
  returnUrl: string;
  cancelUrl: string;
  createdAt: string;
  paidAt: string | null;
  expiredAt: string | null;
}

export interface NewGatewayPayment {
  reference: string;
  environment: string;
  productName: string;
  email: string;
  fullName: string | null;
  amount: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
}

function database(env: NodeJS.ProcessEnv): Database {
  const db = new Database(authDatabasePath(env));
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return db;
}

export function initializeGatewayStore(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(sherlo_gateway_payment)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'callbackUrl' || column.name === 'callbackSecret')) {
    db.exec(`ALTER TABLE sherlo_gateway_payment RENAME TO sherlo_gateway_payment_previous;
    CREATE TABLE sherlo_gateway_payment (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL,
      environment TEXT NOT NULL,
      productName TEXT NOT NULL,
      email TEXT NOT NULL,
      fullName TEXT,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      sessionId TEXT UNIQUE,
      bankUrl TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      returnUrl TEXT NOT NULL,
      cancelUrl TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      paidAt TEXT,
      expiredAt TEXT,
      UNIQUE (reference, environment)
    );
    INSERT INTO sherlo_gateway_payment (
      id, reference, environment, productName, email, fullName, amount, currency,
      sessionId, bankUrl, status, returnUrl, cancelUrl, createdAt, paidAt, expiredAt
    )
    SELECT id, reference, environment, productName, email, fullName, amount, currency,
      sessionId, bankUrl, status, returnUrl, cancelUrl, createdAt, paidAt, expiredAt
    FROM sherlo_gateway_payment_previous;
    DROP TABLE sherlo_gateway_payment_previous;`);
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS sherlo_gateway_payment (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL,
    environment TEXT NOT NULL,
    productName TEXT NOT NULL,
    email TEXT NOT NULL,
    fullName TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    sessionId TEXT UNIQUE,
    bankUrl TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    returnUrl TEXT NOT NULL,
    cancelUrl TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    paidAt TEXT,
    expiredAt TEXT,
    UNIQUE (reference, environment)
  );`);
}

export function gatewayPaymentByReference(
  reference: string,
  environment: string,
  env: NodeJS.ProcessEnv,
): GatewayPayment | null {
  const db = database(env);
  try {
    return (
      (db
        .prepare('SELECT * FROM sherlo_gateway_payment WHERE reference = ? AND environment = ?')
        .get(reference, environment) as GatewayPayment | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

export function gatewayPaymentById(id: string, env: NodeJS.ProcessEnv): GatewayPayment | null {
  const db = database(env);
  try {
    return (
      (db.prepare('SELECT * FROM sherlo_gateway_payment WHERE id = ?').get(id) as GatewayPayment | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

export function insertGatewayPayment(input: NewGatewayPayment, env: NodeJS.ProcessEnv): GatewayPayment {
  const db = database(env);
  try {
    const row: GatewayPayment = {
      ...input,
      id: randomUUID(),
      sessionId: null,
      bankUrl: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      paidAt: null,
      expiredAt: null,
    };
    db.prepare(
      `INSERT INTO sherlo_gateway_payment (
        id, reference, environment, productName, email, fullName, amount, currency,
        status, returnUrl, cancelUrl, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      row.id,
      row.reference,
      row.environment,
      row.productName,
      row.email,
      row.fullName,
      row.amount,
      row.currency,
      row.returnUrl,
      row.cancelUrl,
      row.createdAt,
    );
    return row;
  } finally {
    db.close();
  }
}

/** Reuse the same payment id after a failed or expired attempt. */
export function reopenGatewayPayment(id: string, env: NodeJS.ProcessEnv): void {
  const db = database(env);
  try {
    db.prepare(
      `UPDATE sherlo_gateway_payment
       SET status = 'pending', sessionId = NULL, bankUrl = NULL, paidAt = NULL, expiredAt = NULL
       WHERE id = ? AND status IN ('failed', 'expired')`,
    ).run(id);
  } finally {
    db.close();
  }
}

export function attachGatewaySession(
  id: string,
  sessionId: string,
  bankUrl: string | null,
  env: NodeJS.ProcessEnv,
): void {
  const db = database(env);
  try {
    db.prepare(`UPDATE sherlo_gateway_payment SET sessionId = ?, bankUrl = ? WHERE id = ? AND status = 'pending'`).run(
      sessionId,
      bankUrl,
      id,
    );
  } finally {
    db.close();
  }
}

/**
 * Returns the payment id when this callback belongs to another application's checkout.
 * Returns null when the order is not a gateway payment, so account billing can reject it.
 */
export function applyGatewayPayment(
  payment: SpayonSessionStatus,
  environment: string,
  env: NodeJS.ProcessEnv,
  now = new Date(),
): string | null {
  const db = database(env);
  try {
    const order = db
      .prepare('SELECT * FROM sherlo_gateway_payment WHERE id = ? AND environment = ?')
      .get(payment.orderId, environment) as GatewayPayment | undefined;
    if (!order) return null;
    const amount = Number(payment.price) * 100;
    if (
      order.sessionId !== payment.sessionId ||
      !Number.isFinite(amount) ||
      Math.abs(amount - order.amount) > 0.000001 ||
      payment.currency.toUpperCase() !== order.currency ||
      !['paid', 'pending', 'failed', 'expired'].includes(payment.status)
    ) {
      throw new Error('Spayon payment does not match the gateway order');
    }
    const expiredAt =
      payment.status === 'expired'
        ? payment.updatedAt && !Number.isNaN(Date.parse(payment.updatedAt))
          ? new Date(payment.updatedAt).toISOString()
          : now.toISOString()
        : null;
    db.prepare(
      `UPDATE sherlo_gateway_payment SET status = ?, paidAt = ?,
        expiredAt = CASE WHEN ? IS NULL THEN expiredAt ELSE COALESCE(expiredAt, ?) END
       WHERE id = ? AND paidAt IS NULL`,
    ).run(payment.status, payment.status === 'paid' ? now.toISOString() : null, expiredAt, expiredAt, order.id);
    return order.id;
  } finally {
    db.close();
  }
}
