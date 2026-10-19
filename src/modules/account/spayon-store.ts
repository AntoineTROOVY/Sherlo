/// <reference path="./better-sqlite3.d.ts" />
import Database from 'better-sqlite3';
import { authDatabasePath } from './account-actor';
import type { SpayonSettings } from './spayon-config';
import type { SpayonSessionStatus } from './spayon-client';

export interface SpayonOrder {
  id: string;
  userId: string;
  environment: string;
  sessionId: string | null;
  amount: number;
  currency: string;
  status: string;
  accessUntil: string | null;
  bankUrl: string | null;
  expiredAt: string | null;
}

function database(env: NodeJS.ProcessEnv): Database {
  const db = new Database(authDatabasePath(env));
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return db;
}

export function initializeSpayonStore(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sherlo_spayon_order (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    environment TEXT NOT NULL,
    sessionId TEXT UNIQUE,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    createdAt TEXT NOT NULL,
    paidAt TEXT,
    accessUntil TEXT,
    bankUrl TEXT,
    expiredAt TEXT
  );
  CREATE INDEX IF NOT EXISTS sherlo_spayon_user ON sherlo_spayon_order(userId, environment);`);
  const column = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('sherlo_spayon_order') WHERE name = 'bankUrl'")
    .get() as { n: number };
  if (column.n === 0) db.exec('ALTER TABLE sherlo_spayon_order ADD COLUMN bankUrl TEXT');
  const expiry = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('sherlo_spayon_order') WHERE name = 'expiredAt'")
    .get() as { n: number };
  if (expiry.n === 0) db.exec('ALTER TABLE sherlo_spayon_order ADD COLUMN expiredAt TEXT');
}

export function createSpayonOrder(
  id: string,
  userId: string,
  settings: SpayonSettings,
  env: NodeJS.ProcessEnv,
  amount = settings.amount,
): void {
  const db = database(env);
  try {
    db.prepare(
      `INSERT INTO sherlo_spayon_order (id, userId, environment, amount, currency, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, settings.environment, amount, settings.currency, new Date().toISOString());
  } finally {
    db.close();
  }
}

export function attachSpayonSession(orderId: string, sessionId: string, env: NodeJS.ProcessEnv): void {
  const db = database(env);
  try {
    db.prepare('UPDATE sherlo_spayon_order SET sessionId = ? WHERE id = ? AND sessionId IS NULL').run(
      sessionId,
      orderId,
    );
  } finally {
    db.close();
  }
}

export function rememberSpayonBankUrl(orderId: string, url: string, env: NodeJS.ProcessEnv): void {
  const db = database(env);
  try {
    db.prepare('UPDATE sherlo_spayon_order SET bankUrl = ? WHERE id = ? AND paidAt IS NULL').run(url, orderId);
  } finally {
    db.close();
  }
}

export function spayonOrderForUser(
  sessionId: string | undefined,
  userId: string,
  environment: string,
  env: NodeJS.ProcessEnv,
): SpayonOrder | null {
  const db = database(env);
  try {
    return (
      ((sessionId
        ? db
            .prepare('SELECT * FROM sherlo_spayon_order WHERE sessionId = ? AND userId = ? AND environment = ?')
            .get(sessionId, userId, environment)
        : db
            .prepare(
              `SELECT * FROM sherlo_spayon_order WHERE userId = ? AND environment = ? AND sessionId IS NOT NULL
          ORDER BY createdAt DESC LIMIT 1`,
            )
            .get(userId, environment)) as SpayonOrder | undefined) ?? null
    );
  } finally {
    db.close();
  }
}

export function spayonAccessUntil(userId: string, environment: string, env: NodeJS.ProcessEnv): string | null {
  const db = database(env);
  try {
    const row = db
      .prepare(
        `SELECT MAX(accessUntil) AS accessUntil FROM sherlo_spayon_order
      WHERE userId = ? AND environment = ? AND status = 'paid'`,
      )
      .get(userId, environment) as { accessUntil: string | null };
    return row.accessUntil;
  } finally {
    db.close();
  }
}

/** One atomic update: retries and out-of-order callbacks never extend or revoke a paid grant. */
export function applySpayonPayment(
  payment: SpayonSessionStatus,
  environment: string,
  env: NodeJS.ProcessEnv,
  now = new Date(),
): void {
  const db = database(env);
  try {
    const order = db
      .prepare('SELECT * FROM sherlo_spayon_order WHERE id = ? AND environment = ?')
      .get(payment.orderId, environment) as SpayonOrder | undefined;
    const amount = Number(payment.price) * 100;
    if (
      !order ||
      order.sessionId !== payment.sessionId ||
      !Number.isFinite(amount) ||
      Math.abs(amount - order.amount) > 0.000001 ||
      payment.currency.toUpperCase() !== order.currency ||
      !['paid', 'pending', 'failed', 'expired'].includes(payment.status)
    ) {
      throw new Error('Spayon payment does not match the stored order');
    }
    const accessUntil = new Date(now);
    accessUntil.setUTCFullYear(accessUntil.getUTCFullYear() + 40);
    const expiredAt =
      payment.status === 'expired'
        ? payment.updatedAt && !Number.isNaN(Date.parse(payment.updatedAt))
          ? new Date(payment.updatedAt).toISOString()
          : now.toISOString()
        : null;
    db.prepare(
      `UPDATE sherlo_spayon_order SET status = ?, paidAt = ?, accessUntil = ?,
        expiredAt = CASE WHEN ? IS NULL THEN expiredAt ELSE COALESCE(expiredAt, ?) END
      WHERE id = ? AND paidAt IS NULL`,
    ).run(
      payment.status,
      payment.status === 'paid' ? now.toISOString() : null,
      payment.status === 'paid' ? accessUntil.toISOString() : null,
      expiredAt,
      expiredAt,
      order.id,
    );
  } finally {
    db.close();
  }
}
