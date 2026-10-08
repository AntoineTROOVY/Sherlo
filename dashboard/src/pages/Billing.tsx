import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Check, CreditCard, Loader2 } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useBillingAccess } from '../hooks/useBillingAccess';
import { PageHeader } from '../components/PageHeader';
import { API_BASE_URL } from '../services/api';
import './Billing.css';

interface CatalogProduct {
  slug: string;
  name: string;
  description: string | null;
  interval: string | null;
  amount: number | null;
  currency: string | null;
}

interface PolarSubscription {
  status?: string;
  current_period_end?: string;
  product?: { name?: string; description?: string | null };
  price?: {
    price_amount?: number;
    price_currency?: string;
    recurring_interval?: string | null;
  };
}

interface CustomerState {
  active_subscriptions?: PolarSubscription[];
}

type BillingView =
  | { kind: 'loading' }
  | { kind: 'off' }
  | {
      kind: 'ready';
      provider: 'stripe' | 'polar';
      products: CatalogProduct[];
      subscribed: boolean;
      subscription: PolarSubscription | null;
      error: string;
    };

async function accountFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function money(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function planPrice(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return money(amount, currency, locale);
  }
}

function formatDate(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date);
}

function proPlanFeatures(t: TFunction): string[] {
  const features = t('billing.proPlan.features', { returnObjects: true });
  return Array.isArray(features) ? (features as string[]) : [];
}

function resolveProPricing(product: CatalogProduct | null, locale: string, t: TFunction) {
  if (product?.amount != null && product.currency) {
    const formatted = planPrice(product.amount, product.currency, locale);
    if (product.interval === 'month') {
      const yearly = planPrice(product.amount * 12, product.currency, locale);
      return {
        priceMain: formatted,
        priceYear: t('billing.proPlan.yearlyFromMonthly', { amount: yearly }),
      };
    }
    if (product.interval === 'year') {
      return {
        priceMain: formatted,
        priceYear: t('billing.proPlan.billedYearly'),
      };
    }
    return { priceMain: formatted, priceYear: '' };
  }
  return {
    priceMain: t('billing.proPlan.priceMain'),
    priceYear: t('billing.proPlan.priceYear'),
  };
}

export function Billing() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('billing.title'));
  const [view, setView] = useState<BillingView>({ kind: 'loading' });
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const { access: billingAccess, refresh: refreshBillingAccess } = useBillingAccess();

  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    const statusProbe = await accountFetch('/account/billing/status');
    if (statusProbe.status === 404) {
      setView({ kind: 'off' });
      return;
    }
    let statusBody = statusProbe.ok
      ? ((await statusProbe.json()) as { provider?: 'stripe' | 'polar'; subscribed?: boolean })
      : null;
    const provider = statusBody?.provider === 'stripe' ? 'stripe' : 'polar';
    if (provider === 'stripe' && statusBody?.subscribed !== true) {
      const sync = await accountFetch('/account/stripe/sync', { method: 'POST', body: '{}' });
      if (sync.ok) {
        statusBody = (await sync.json()) as { provider?: 'stripe' | 'polar'; subscribed?: boolean };
      }
    }
    const catalog = await accountFetch(
      provider === 'stripe' ? '/account/stripe/catalog' : '/account/polar/catalog',
    );
    if (catalog.status === 404) {
      setView({ kind: 'off' });
      return;
    }
    if (catalog.status === 401 || catalog.status === 403) {
      setView({
        kind: 'ready',
        provider,
        products: [],
        subscribed: false,
        subscription: null,
        error: t('billing.sessionError'),
      });
      return;
    }
    if (!catalog.ok) {
      setView({
        kind: 'ready',
        provider,
        products: [],
        subscribed: false,
        subscription: null,
        error: t('billing.error'),
      });
      return;
    }
    const body = (await catalog.json()) as { products?: CatalogProduct[] };
    let subscribed = statusBody?.subscribed === true;
    let subscription: PolarSubscription | null = null;
    if (provider === 'polar') {
      const state = await accountFetch('/account/customer/state');
      const stateBody = state.ok ? ((await state.json()) as CustomerState) : null;
      subscription = stateBody?.active_subscriptions?.[0] ?? null;
      subscribed = (stateBody?.active_subscriptions?.length ?? 0) > 0;
    }
    setView({
      kind: 'ready',
      provider,
      products: body.products ?? [],
      subscribed,
      subscription,
      error: '',
    });
  }, [t]);

  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get('checkout') === 'success') {
        const sessionId = params.get('session_id');
        try {
          await accountFetch('/account/stripe/sync', {
            method: 'POST',
            body: JSON.stringify(sessionId ? { sessionId } : {}),
          });
        } catch {
          // Sync is best-effort; billing/status still re-checks Stripe when a customer id exists.
        }
        window.history.replaceState({}, '', `${window.location.pathname}`);
        void refreshBillingAccess();
      }
      await load();
    })().catch(() =>
      setView({
        kind: 'ready',
        provider: 'stripe',
        products: [],
        subscribed: false,
        subscription: null,
        error: t('billing.error'),
      }),
    );
  }, [load, t, refreshBillingAccess]);

  const openCheckout = async (pendingKey: string) => {
    if (view.kind !== 'ready') return;
    const path = view.provider === 'stripe' ? '/account/stripe/checkout' : '/account/checkout';
    const body =
      view.provider === 'stripe'
        ? {}
        : { slug: view.products[0]?.slug ?? 'pro', redirect: false };
    await openBilling(path, body, pendingKey);
  };

  const openPortal = async () => {
    if (view.kind !== 'ready') return;
    const path = view.provider === 'stripe' ? '/account/stripe/portal' : '/account/customer/portal';
    const body = view.provider === 'stripe' ? {} : { redirect: false };
    await openBilling(path, body, 'portal');
  };

  const openBilling = async (path: string, body: Record<string, unknown>, pendingKey: string) => {
    setPending(pendingKey);
    setActionError('');
    try {
      const response = await accountFetch(path, { method: 'POST', body: JSON.stringify(body) });
      const payload = (await response.json().catch(() => ({}))) as { url?: string; message?: string };
      if (!response.ok || !payload.url) {
        setActionError(payload.message || t('billing.error'));
        return;
      }
      window.location.assign(payload.url);
    } catch {
      setActionError(t('billing.error'));
    } finally {
      setPending(null);
      void refreshBillingAccess();
    }
  };

  const primaryProduct = view.kind === 'ready' ? (view.products[0] ?? null) : null;
  const proPricing = resolveProPricing(primaryProduct, i18n.language, t);
  const proFeatures = proPlanFeatures(t);

  const subscribedPlanName =
    view.kind === 'ready'
      ? view.subscription?.product?.name?.trim() ||
        view.products[0]?.name?.trim() ||
        t('billing.proPlan.name')
      : null;

  const subscribedPrice =
    view.kind === 'ready' && view.subscription?.price?.price_amount != null && view.subscription.price.price_currency
      ? money(view.subscription.price.price_amount, view.subscription.price.price_currency, i18n.language)
      : null;

  const renewalDate =
    view.kind === 'ready' && view.subscription
      ? formatDate(view.subscription.current_period_end, i18n.language)
      : null;

  return (
    <div className="billing-page">
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />

      {view.kind === 'loading' && (
        <div className="billing-loading">
          <Loader2 className="animate-spin" size={28} />
          <span>{t('billing.loading')}</span>
        </div>
      )}

      {view.kind === 'off' && (
        <div className="billing-panel billing-panel--muted">
          <p>{t('billing.notConfigured')}</p>
        </div>
      )}

      {view.kind === 'ready' && (
        <>
          {billingAccess?.paymentRequired && (
            <div className="billing-alert billing-alert--warning">{t('billing.trialExpired')}</div>
          )}
          {view.error && <div className="billing-alert billing-alert--error">{view.error}</div>}
          {actionError && <div className="billing-alert billing-alert--error">{actionError}</div>}

          {!view.subscribed && (
            <>
              <header className="billing-hero billing-hero--inactive">
                <p className="billing-eyebrow">{t('billing.notSubscribedEyebrow')}</p>
                <h2 className="billing-hero-title">{t('billing.notSubscribedTitle')}</h2>
                <p className="billing-hero-lead">{t('billing.notSubscribedLead')}</p>
              </header>

              {primaryProduct ? (
                <article className="billing-pro-card">
                  <span className="billing-pro-badge">{t('billing.proPlan.badge')}</span>
                  <h3 className="billing-pro-name">{t('billing.proPlan.name')}</h3>
                  <div className="billing-pro-price-row">
                    <span className="billing-pro-price-main">{proPricing.priceMain}</span>
                    <span className="billing-pro-price-per">{t('billing.proPlan.perMonth')}</span>
                  </div>
                  {proPricing.priceYear && <p className="billing-pro-price-year">{proPricing.priceYear}</p>}
                  <p className="billing-pro-desc">
                    {primaryProduct.description?.trim() || t('billing.proPlan.description')}
                  </p>
                  <hr className="billing-pro-divider" />
                  <ul className="billing-pro-features">
                    {proFeatures.map(feature => (
                      <li key={feature}>
                        <Check size={18} strokeWidth={2.5} aria-hidden />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="billing-pro-cta"
                    disabled={pending !== null}
                    onClick={() => void openCheckout(primaryProduct.slug)}
                  >
                    {pending === primaryProduct.slug ? t('billing.redirecting') : t('billing.proPlan.cta')}
                  </button>
                </article>
              ) : (
                <div className="billing-panel billing-panel--muted">
                  <p>{t('billing.empty')}</p>
                </div>
              )}
            </>
          )}

          {view.subscribed && (
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
                    <span className="billing-detail-value">{subscribedPlanName}</span>
                  </div>
                  {subscribedPrice && (
                    <div className="billing-detail">
                      <span className="billing-detail-label">{t('billing.detail.price')}</span>
                      <span className="billing-detail-value">{subscribedPrice}</span>
                    </div>
                  )}
                  {(view.subscription?.status || view.subscribed) && (
                    <div className="billing-detail">
                      <span className="billing-detail-label">{t('billing.detail.status')}</span>
                      <span className="billing-detail-value billing-detail-value--status">
                        {view.subscription?.status
                          ? t(`billing.status.${view.subscription.status}`, {
                              defaultValue: view.subscription.status,
                            })
                          : t('billing.status.active')}
                      </span>
                    </div>
                  )}
                  {renewalDate && (
                    <div className="billing-detail">
                      <span className="billing-detail-label">{t('billing.detail.renewal')}</span>
                      <span className="billing-detail-value">{renewalDate}</span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="btn-secondary billing-portal-btn"
                  disabled={pending !== null}
                  onClick={() => void openPortal()}
                >
                  <CreditCard size={18} aria-hidden />
                  {pending === 'portal' ? t('billing.redirecting') : t('billing.manage')}
                </button>
              </article>
            </>
          )}
        </>
      )}
    </div>
  );
}
