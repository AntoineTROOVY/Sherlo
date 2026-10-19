import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useBillingAccess, type BillingAccess } from '../hooks/useBillingAccess';
import { PageHeader } from '../components/PageHeader';
import { API_BASE_URL } from '../services/api';
import './Billing.css';

interface CatalogProduct {
  slug: string;
  name: string;
  amount: number;
  currency: string;
}

type PaymentStatus = 'paid' | 'pending' | 'failed' | 'expired';
type BillingView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      product: CatalogProduct;
      access: BillingAccess;
      checkoutAvailable: boolean;
      paymentStatus: PaymentStatus | null;
      expiredAt: string | null;
      verificationFailed: boolean;
    };

async function accountFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}/account${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function money(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100);
}

export function Billing() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('billing.title'));
  const [view, setView] = useState<BillingView>({ kind: 'loading' });
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [reload, setReload] = useState(0);
  const [promoCode, setPromoCode] = useState('');
  const [promo, setPromo] = useState<{ amount: number; discount: number } | null>(null);
  const [promoError, setPromoError] = useState('');
  const [promoPending, setPromoPending] = useState(false);
  const { refresh: refreshBillingAccess } = useBillingAccess();

  const load = useCallback(async (signal: AbortSignal): Promise<BillingView> => {
    const [catalog, status] = await Promise.all([
      accountFetch('/spayon/catalog', { signal }),
      accountFetch('/billing/status', { signal }),
    ]);
    if (!catalog.ok || !status.ok) throw new Error('Could not load billing');
    const catalogBody = (await catalog.json()) as { products: CatalogProduct[]; checkoutAvailable: boolean };
    let access = (await status.json()) as BillingAccess;
    const product = catalogBody.products[0];
    if (!product) throw new Error('Missing product');
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('sessionId');
    let paymentStatus: PaymentStatus | null = null;
    let expiredAt: string | null = null;
    let verificationFailed = false;
    // The server only reconciles a session owned by this account. A redirect never grants access.
    if (sessionId || !access.subscribed) {
      try {
        const sync = await accountFetch('/spayon/sync', {
          method: 'POST',
          body: JSON.stringify(sessionId ? { sessionId } : {}),
          signal,
        });
        if (!sync.ok) throw new Error('Could not verify payment');
        const synced = (await sync.json()) as BillingAccess & {
          paymentStatus: PaymentStatus | null;
          expiredAt?: string | null;
        };
        access = synced;
        paymentStatus = synced.paymentStatus;
        expiredAt = synced.expiredAt ?? null;
        if (sessionId && paymentStatus && paymentStatus !== 'pending') {
          params.delete('sessionId');
          params.delete('checkout');
          const query = params.toString();
          window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        verificationFailed = true;
      }
    }
    return {
      kind: 'ready',
      product,
      access,
      checkoutAvailable: catalogBody.checkoutAvailable,
      paymentStatus,
      expiredAt,
      verificationFailed,
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setView(result);
          void refreshBillingAccess();
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setView({ kind: 'error' });
      });
    return () => controller.abort();
  }, [load, reload, refreshBillingAccess]);

  const awaitingPayment = view.kind === 'ready' && !view.access.subscribed;
  useEffect(() => {
    if (!awaitingPayment) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void accountFetch('/spayon/sync', { method: 'POST', body: '{}' })
        .then(async response => {
          if (!response.ok || cancelled) return;
          const synced = (await response.json()) as BillingAccess & {
            paymentStatus: PaymentStatus | null;
            expiredAt?: string | null;
          };
          if (cancelled) return;
          setView(current =>
            current.kind === 'ready'
              ? {
                  ...current,
                  access: synced,
                  paymentStatus: synced.paymentStatus,
                  expiredAt: synced.expiredAt ?? null,
                  verificationFailed: false,
                }
              : current,
          );
          if (synced.subscribed) void refreshBillingAccess();
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [awaitingPayment, refreshBillingAccess]);

  const openCheckout = async () => {
    setPending(true);
    setActionError('');
    try {
      const response = await accountFetch('/spayon/checkout', {
        method: 'POST',
        body: JSON.stringify(promo ? { promoCode: promoCode.trim() } : {}),
      });
      if (response.status === 409) {
        setReload(value => value + 1);
        return;
      }
      const payload = (await response.json()) as { url?: string };
      if (!response.ok || !payload.url) throw new Error('Checkout unavailable');
      window.location.assign(payload.url);
    } catch {
      setActionError(t('billing.error'));
    } finally {
      setPending(false);
    }
  };

  const applyPromo = async () => {
    setPromoPending(true);
    setPromoError('');
    try {
      const response = await accountFetch('/spayon/quote', {
        method: 'POST',
        body: JSON.stringify({ promoCode: promoCode.trim() }),
      });
      if (!response.ok) {
        setPromo(null);
        setPromoError(t('billing.promoInvalid'));
        return;
      }
      setPromo((await response.json()) as { amount: number; discount: number });
    } catch {
      setPromo(null);
      setPromoError(t('billing.promoInvalid'));
    } finally {
      setPromoPending(false);
    }
  };

  const features = t('billing.proPlan.features', { returnObjects: true });
  const price =
    view.kind === 'ready' ? money(promo?.amount ?? view.product.amount, view.product.currency, i18n.language) : '';
  const listPrice = view.kind === 'ready' ? money(view.product.amount, view.product.currency, i18n.language) : '';
  const expiredOn =
    view.kind === 'ready' && view.expiredAt
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long', timeStyle: 'short' }).format(
          new Date(view.expiredAt),
        )
      : null;
  const accessUntil =
    view.kind === 'ready' && view.access.accessUntil
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' }).format(new Date(view.access.accessUntil))
      : null;

  return (
    <div className="billing-page">
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      {view.kind === 'loading' && (
        <div className="billing-loading" role="status">
          <Loader2 className="animate-spin" size={28} aria-hidden />
          <span>{t('billing.loading')}</span>
        </div>
      )}
      {view.kind === 'error' && (
        <div className="billing-alert billing-alert--error" role="alert">
          <p>{t('billing.error')}</p>
          <button className="btn-secondary" onClick={() => setReload(value => value + 1)}>
            {t('billing.retry')}
          </button>
        </div>
      )}
      {view.kind === 'ready' && (
        <>
          {view.access.paymentRequired && (
            <div className="billing-alert billing-alert--warning">{t('billing.trialExpired')}</div>
          )}
          {actionError && (
            <div className="billing-alert billing-alert--error" role="alert">
              {actionError}
            </div>
          )}
          {(view.verificationFailed || view.paymentStatus) && (
            <div className="billing-panel" role="status">
              <p>
                {view.paymentStatus === 'expired' && expiredOn
                  ? t('billing.expiredOn', { date: expiredOn })
                  : t(view.verificationFailed ? 'billing.verificationFailed' : `billing.payment.${view.paymentStatus}`)}
              </p>
            </div>
          )}
          {!view.access.subscribed ? (
            <>
              <header className="billing-hero billing-hero--inactive">
                <p className="billing-eyebrow">{t('billing.notSubscribedEyebrow')}</p>
                <h2 className="billing-hero-title">{t('billing.notSubscribedTitle')}</h2>
                <p className="billing-hero-lead">{t('billing.notSubscribedLead')}</p>
              </header>
              <article className="billing-pro-card">
                <span className="billing-pro-badge">{t('billing.proPlan.badge')}</span>
                <h3 className="billing-pro-name">{view.product.name}</h3>
                <div className="billing-pro-price-row">
                  {promo && <span className="billing-pro-price-was">{listPrice}</span>}
                  <span className="billing-pro-price-main">{price}</span>
                  <span className="billing-pro-price-per">{t('billing.oneTime')}</span>
                </div>
                <form
                  className="billing-promo"
                  onSubmit={event => {
                    event.preventDefault();
                    void applyPromo();
                  }}
                >
                  <input
                    aria-label={t('billing.promoLabel')}
                    placeholder={t('billing.promoLabel')}
                    value={promoCode}
                    autoComplete="off"
                    maxLength={80}
                    onChange={event => {
                      setPromoCode(event.target.value);
                      setPromo(null);
                      setPromoError('');
                    }}
                  />
                  <button type="submit" disabled={promoPending || promoCode.trim().length === 0}>
                    {t('billing.promoApply')}
                  </button>
                </form>
                {promo && (
                  <p className="billing-promo-note">
                    {t('billing.promoApplied', {
                      amount: money(promo.discount, view.product.currency, i18n.language),
                    })}
                  </p>
                )}
                {promoError && (
                  <p className="billing-promo-note billing-promo-note--error" role="alert">
                    {promoError}
                  </p>
                )}
                <p className="billing-pro-price-year">{t('billing.accessDuration')}</p>
                <p className="billing-pro-desc">{t('billing.proPlan.description')}</p>
                <hr className="billing-pro-divider" />
                <ul className="billing-pro-features">
                  {(Array.isArray(features) ? (features as string[]) : []).map(feature => (
                    <li key={feature}>
                      <Check size={18} strokeWidth={2.5} aria-hidden />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                {!view.checkoutAvailable && <p role="status">{t('billing.notConfigured')}</p>}
                <button
                  type="button"
                  className="billing-pro-cta"
                  disabled={pending || !view.checkoutAvailable}
                  onClick={() => void openCheckout()}
                >
                  {pending
                    ? t('billing.redirecting')
                    : view.paymentStatus === 'pending'
                      ? t('billing.resumePayment')
                      : t('billing.proPlan.cta')}
                </button>
                <p className="billing-pro-desc">{t('billing.checkoutFootnote')}</p>
                <p className="billing-pro-desc">
                  {t('billing.paymentTermsIntro')}{' '}
                  <a href="https://pay.scoupon.am/en/sales-terms" target="_blank" rel="noopener noreferrer">
                    {t('billing.paymentTermsSale')}
                  </a>{' '}
                  {t('billing.paymentTermsAnd')}{' '}
                  <a href="https://pay.scoupon.am/en/privacy-policy" target="_blank" rel="noopener noreferrer">
                    {t('billing.paymentTermsPrivacy')}
                  </a>{' '}
                  {t('billing.paymentTermsProvider')}
                </p>
              </article>
            </>
          ) : (
            <>
              <header className="billing-hero billing-hero--active">
                <p className="billing-eyebrow">{t('billing.subscribedEyebrow')}</p>
                <h2 className="billing-hero-title">{t('billing.subscribedTitle')}</h2>
                <p className="billing-hero-lead">{t('billing.subscribedLead')}</p>
              </header>
              <article className="billing-subscription-card">
                <div className="billing-subscription-grid">
                  <div className="billing-detail">
                    <span className="billing-detail-label">{t('billing.detail.plan')}</span>
                    <span className="billing-detail-value">{view.product.name}</span>
                  </div>
                  <div className="billing-detail">
                    <span className="billing-detail-label">{t('billing.detail.status')}</span>
                    <span className="billing-detail-value billing-detail-value--status">
                      {t('billing.status.active')}
                    </span>
                  </div>
                  {accessUntil && (
                    <div className="billing-detail">
                      <span className="billing-detail-label">{t('billing.validUntil')}</span>
                      <span className="billing-detail-value">{accessUntil}</span>
                    </div>
                  )}
                </div>
              </article>
            </>
          )}
          <article className="billing-panel billing-api-key">
            <h3>{t('billing.apiKeyTitle')}</h3>
            <p>{t('billing.apiKeyLead')}</p>
            <a className="btn-secondary" href="/api-keys">
              {t('billing.apiKeyAction')}
            </a>
          </article>
        </>
      )}
    </div>
  );
}
