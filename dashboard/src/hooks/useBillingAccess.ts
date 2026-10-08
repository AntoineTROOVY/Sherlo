import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '../services/api';

export interface BillingAccess {
  billingEnabled: boolean;
  provider?: 'stripe' | 'polar' | null;
  subscribed: boolean;
  trialDaysTotal: number;
  trialDaysRemaining: number | null;
  trialLastDay: boolean;
  paymentRequired: boolean;
}

export function useBillingAccess(): {
  access: BillingAccess | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [access, setAccess] = useState<BillingAccess | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/account/billing/status`, { credentials: 'include' });
      if (response.status === 404) {
        setAccess({
          billingEnabled: false,
          subscribed: false,
          trialDaysTotal: 3,
          trialDaysRemaining: null,
          trialLastDay: false,
          paymentRequired: false,
        });
        return;
      }
      if (!response.ok) {
        setAccess(null);
        return;
      }
      setAccess((await response.json()) as BillingAccess);
    } catch {
      setAccess(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { access, loading, refresh };
}
