import { trialDaysRemaining, trialActive } from './account-trial';

describe('account trial', () => {
  it('grants three full days from account creation by default', () => {
    const created = new Date('2026-01-01T12:00:00.000Z');
    expect(trialDaysRemaining(created, 3, new Date('2026-01-01T18:00:00.000Z'))).toBe(3);
    expect(trialDaysRemaining(created, 3, new Date('2026-01-03T12:00:00.000Z'))).toBe(1);
    expect(trialActive(created, 3, new Date('2026-01-04T11:59:59.000Z'))).toBe(true);
    expect(trialActive(created, 3, new Date('2026-01-04T12:00:01.000Z'))).toBe(false);
  });
});
