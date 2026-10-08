import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { BillingAccess } from '../hooks/useBillingAccess';
import './TrialBanner.css';

interface TrialBannerProps {
  access: BillingAccess;
}

export function TrialBanner({ access }: TrialBannerProps) {
  const { t } = useTranslation();

  if (!access.billingEnabled || access.subscribed || access.paymentRequired) return null;
  if (access.trialDaysRemaining === null || access.trialDaysRemaining <= 0) return null;

  const message = access.trialLastDay
    ? t('billing.trialLastDay')
    : t('billing.trialDaysRemaining', { count: access.trialDaysRemaining });

  return (
    <div className={`trial-banner${access.trialLastDay ? ' is-last-day' : ''}`} role="status">
      <span>{message}</span>
      <Link to="/billing">{t('billing.trialCta')}</Link>
    </div>
  );
}
