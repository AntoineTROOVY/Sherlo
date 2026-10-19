import SqliteDriver from 'better-sqlite3';
import { authDatabasePath } from './account-actor';

export type AuthUserBillingRow = {
  id: string;
  email: string;
  role?: string | null;
  createdAt: string | Date;
};

export function loadAuthUserBillingRow(userId: string, env: NodeJS.ProcessEnv): AuthUserBillingRow | null {
  const path = authDatabasePath(env);
  const db = new SqliteDriver(path);
  try {
    const row = db.prepare(`SELECT id, email, role, createdAt FROM "user" WHERE id = ?`).get(userId) as
      AuthUserBillingRow | undefined;
    return row ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
