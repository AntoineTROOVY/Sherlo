const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveTrialDays(env: NodeJS.ProcessEnv): number {
  const raw = env.TRIAL_DAYS?.trim();
  if (!raw) return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export function trialEndsAt(createdAt: Date, trialDays: number): Date {
  return new Date(createdAt.getTime() + trialDays * MS_PER_DAY);
}

/** Whole days left in the trial window (1 = last day). Zero when expired. */
export function trialDaysRemaining(createdAt: Date, trialDays: number, now = new Date()): number {
  const end = trialEndsAt(createdAt, trialDays);
  const msLeft = end.getTime() - now.getTime();
  if (msLeft <= 0) return 0;
  return Math.ceil(msLeft / MS_PER_DAY);
}

export function trialActive(createdAt: Date, trialDays: number, now = new Date()): boolean {
  return trialDaysRemaining(createdAt, trialDays, now) > 0;
}
