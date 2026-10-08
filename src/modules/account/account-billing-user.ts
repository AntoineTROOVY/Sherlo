import SqliteDriver from 'better-sqlite3';
import { authDatabasePath } from './account-actor';

export type AuthUserBillingRow = {
  id: string;
  email: string;
  role?: string | null;
  createdAt: string | Date;
  stripeCustomerId?: string | null;
  subscriptionStatus?: string | null;
};

export function loadAuthUserBillingRow(userId: string, env: NodeJS.ProcessEnv): AuthUserBillingRow | null {
  const path = authDatabasePath(env);
  const db = new SqliteDriver(path);
  try {
    const row = db
      .prepare(
        `SELECT id, email, role, createdAt, stripeCustomerId, subscriptionStatus FROM "user" WHERE id = ?`,
      )
      .get(userId) as AuthUserBillingRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function findAuthUserIdByStripeCustomerId(
  customerId: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const trimmed = customerId.trim();
  if (!trimmed) return null;
  const path = authDatabasePath(env);
  const db = new SqliteDriver(path);
  try {
    const row = db
      .prepare(`SELECT id FROM "user" WHERE stripeCustomerId = ? LIMIT 1`)
      .get(trimmed) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}
