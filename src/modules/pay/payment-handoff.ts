import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { authDatabasePath, resolveBetterAuthBaseURL } from '../account/account-actor';
import { acceptedOrigin } from './pay-origin';

const TOKEN = /^[0-9a-f]{32}$/;

export function initializePaymentHandoff(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sherlo_payment_handoff (
    token TEXT PRIMARY KEY,
    destination TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );`);
}

function database(env: NodeJS.ProcessEnv): Database {
  const db = new Database(authDatabasePath(env));
  db.exec('PRAGMA busy_timeout = 5000;');
  initializePaymentHandoff(db);
  return db;
}

/** One opaque Sherlo address. Spayon cannot tell a return from a cancel, or a site subscription from an external application. */
export function issuePaymentHandoff(destination: string, env: NodeJS.ProcessEnv = process.env): string {
  const db = database(env);
  try {
    const token = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO sherlo_payment_handoff (token, destination, createdAt) VALUES (?, ?, ?)').run(
      token,
      destination,
      new Date().toISOString(),
    );
    return providerHandoffUrl(token, env);
  } finally {
    db.close();
  }
}

export function paymentHandoffDestination(token: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!TOKEN.test(token)) return null;
  const db = database(env);
  try {
    const row = db.prepare('SELECT destination FROM sherlo_payment_handoff WHERE token = ?').get(token) as
      | { destination: string }
      | undefined;
    return row?.destination ?? null;
  } finally {
    db.close();
  }
}

export function providerHandoffUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const origin = acceptedOrigin(resolveBetterAuthBaseURL(env), env) ?? 'https://api.sherlo.co';
  return `${origin}/api/pay/r/${token}`;
}
