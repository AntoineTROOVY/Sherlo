import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let Billing: (typeof import('./Billing.tsx'))['Billing'];
let paymentStatus: 'paid' | 'pending' | 'failed' | 'expired' | null;
let subscribed: boolean;
let configured: boolean;
let syncFailure: boolean;
let syncGate: Promise<void> | null;
let requests: Array<{ path: string; body: unknown }>;
const originalFetch = globalThis.fetch;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady, default: i18n } = await import('../i18n/index.ts');
  await i18nReady;
  await i18n.changeLanguage('fr');
  rtl = await import('@testing-library/react');
  ({ Billing } = await import('./Billing.tsx'));
});

beforeEach(() => {
  paymentStatus = null;
  subscribed = false;
  configured = true;
  syncFailure = false;
  syncGate = null;
  requests = [];
  window.history.replaceState({}, '', '/billing');
  globalThis.fetch = (async (input, init) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const access = {
      provider: 'spayon',
      subscribed,
      billingEnabled: true,
      paymentRequired: !subscribed,
      trialDaysTotal: 3,
      trialDaysRemaining: 0,
      trialLastDay: false,
      accessUntil: subscribed ? '2066-10-19T12:00:00Z' : null,
    };
    if (path.endsWith('/billing/status')) return Response.json(access);
    if (path.endsWith('/spayon/catalog'))
      return Response.json({
        checkoutAvailable: configured,
        products: [{ slug: 'pro', name: 'Sherlo Pro', amount: 5900, currency: 'EUR' }],
      });
    if (path.endsWith('/spayon/quote')) {
      const code = (requests.at(-1)?.body as { promoCode?: string } | null)?.promoCode;
      return code === 'TEST-4'
        ? Response.json({ amount: 400, currency: 'EUR', discount: 5500 })
        : Response.json({ message: 'invalid' }, { status: 400 });
    }
    if (path.endsWith('/spayon/sync')) {
      if (syncGate) await syncGate;
      return syncFailure
        ? Response.json({ message: 'unavailable' }, { status: 502 })
        : Response.json({
            ...access,
            paymentStatus,
            expiredAt: paymentStatus === 'expired' ? '2026-10-19T09:24:29.670Z' : null,
          });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = originalFetch;
});

test('shows 59 EUR as a single payment for 40 years, without a monthly price or portal', async () => {
  rtl.render(createElement(Billing));
  await rtl.screen.findByRole('button', { name: 'Activer Pro' });
  assert.equal(rtl.screen.getByRole('link', { name: 'Créer une clé API' }).getAttribute('href'), '/api-keys');
  assert.match(document.body.textContent!, /59,00\s*€/);
  assert.match(document.body.textContent!, /paiement unique/);
  assert.match(document.body.textContent!, /40 ans d’accès/);
  assert.doesNotMatch(document.body.textContent!, /\/mois|\/ an|Polar|Stripe/);
  assert.equal(rtl.screen.queryByRole('button', { name: 'Gérer l’abonnement' }), null);
});

test('keeps a pending payment open and checks its result every 3 seconds', async () => {
  paymentStatus = 'pending';
  rtl.render(createElement(Billing));
  const button = await rtl.screen.findByRole('button', { name: 'Reprendre le paiement' });
  assert.equal((button as HTMLButtonElement).disabled, false);
  assert.equal(rtl.screen.queryByRole('button', { name: 'Actualiser le statut du paiement' }), null);
  const before = requests.filter(row => row.path.endsWith('/spayon/sync')).length;
  paymentStatus = 'paid';
  subscribed = true;
  await new Promise(resolve => setTimeout(resolve, 3200));
  await rtl.screen.findByText('Sherlo est débloqué');
  assert.ok(requests.filter(row => row.path.endsWith('/spayon/sync')).length > before);
});

test('never trusts the return URL to indicate success when verification fails', async () => {
  window.history.replaceState({}, '', '/billing?checkout=returned&sessionId=session-1');
  syncFailure = true;
  rtl.render(createElement(Billing));
  await rtl.screen.findByText(/Le statut du paiement est momentanément indisponible/);
  assert.equal((rtl.screen.getByRole('button', { name: 'Activer Pro' }) as HTMLButtonElement).disabled, false);
  assert.equal(rtl.screen.queryByText('Sherlo est débloqué'), null);
  assert.deepEqual(requests.find(row => row.path.endsWith('/spayon/sync'))?.body, { sessionId: 'session-1' });
  assert.equal(new URLSearchParams(window.location.search).get('sessionId'), 'session-1');
});

test('shows the stored access expiry after a confirmed payment and removes return parameters', async () => {
  window.history.replaceState({}, '', '/billing?checkout=returned&sessionId=session-1');
  subscribed = true;
  paymentStatus = 'paid';
  rtl.render(createElement(Billing));
  await rtl.screen.findByText('Sherlo est débloqué');
  assert.match(document.body.textContent!, /2066/);
  assert.equal(window.location.search, '');
  assert.equal(rtl.screen.queryByRole('button', { name: 'Activer Pro' }), null);
});

test('shows a clear unavailable state before server credentials are installed', async () => {
  configured = false;
  rtl.render(createElement(Billing));
  await rtl.screen.findByText('Le paiement n’est pas encore disponible. Contactez le support.');
  assert.equal((rtl.screen.getByRole('button', { name: 'Activer Pro' }) as HTMLButtonElement).disabled, true);
});

test('marks the moment a payment session expired and still allows a new payment', async () => {
  paymentStatus = 'expired';
  rtl.render(createElement(Billing));
  await rtl.screen.findByText(/19 octobre 2026/);
  assert.equal((rtl.screen.getByRole('button', { name: 'Activer Pro' }) as HTMLButtonElement).disabled, false);
});

test('applies a server-validated promo code and shows the reduced price', async () => {
  rtl.render(createElement(Billing));
  await rtl.screen.findByRole('button', { name: 'Activer Pro' });
  const field = rtl.screen.getByLabelText('Code promo');
  rtl.fireEvent.change(field, { target: { value: 'WRONG' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Appliquer' }));
  await rtl.screen.findByText('Code promo invalide.');
  rtl.fireEvent.change(field, { target: { value: 'TEST-4' } });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Appliquer' }));
  await rtl.screen.findByText(/Réduction de\s+55,00\s*€/);
  assert.match(document.body.textContent!, /4,00\s*€/);
});
