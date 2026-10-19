import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { SpayonClient, type SpayonCheckoutRequest } from '../account/spayon-client';
import { resolveSpayonSettings, spayonUrls } from '../account/spayon-config';
import { spayonCardCheckoutUrl, validateSpayonBankUrl } from '../account/spayon-card-checkout';
import {
  attachGatewaySession,
  gatewayPaymentById,
  gatewayPaymentByReference,
  initializeGatewayStore,
  insertGatewayPayment,
  markTestPaymentPaid,
  reopenGatewayPayment,
  testTokenMatches,
  type GatewayPayment,
} from './pay-store';
import { acceptedOrigin } from './pay-origin';
import { issuePaymentHandoff } from './payment-handoff';
import { testAmdQuote, testCardPage, testClosedPage } from './pay-test-page';
import Database from 'better-sqlite3';
import { authDatabasePath } from '../account/account-actor';

const logger = createLogger('Pay');

/** The only product title the payment provider is allowed to see. */
export const PROVIDER_PRODUCT_NAME = 'Sherlo Pro';

export interface CreatePayCheckout {
  amount: number;
  currency?: string;
  productName: string;
  email: string;
  fullName?: string;
  reference: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PayCheckoutOptions {
  /** A payment-test API key opens Sherlo's card page and never calls the bank. */
  test: boolean;
  origin: string;
}

export type TestPageResult = { action: 'html'; status: number; html: string } | { action: 'redirect'; location: string };

export interface PayCheckoutResult {
  id: string;
  reference: string;
  status: string;
  /** Exact currency units, such as 4 for 4.00 EUR. */
  amount: number;
  currency: string;
  /** Amount in AMD the buyer pays. Null until the bank page has been opened. */
  amountAmd: number | null;
  /** AMD for one unit of currency. Null until the bank page has been opened. */
  exchangeRate: number | null;
  /** Bank page only. Absent once the payment is no longer payable. */
  url: string | null;
  paidAt: string | null;
  expiredAt: string | null;
}

@Injectable()
export class PayService {
  private ready = false;

  create(input: CreatePayCheckout, options: PayCheckoutOptions): Promise<PayCheckoutResult> {
    return this.open(input, options);
  }

  find(id: string, test: boolean): PayCheckoutResult {
    this.ensureStore();
    const payment = gatewayPaymentById(id, process.env);
    if (!payment || (payment.environment === 'test') !== test) throw new NotFoundException('Payment not found');
    return view(payment);
  }

  testCheckout(id: string, token: string | undefined): TestPageResult | null {
    const payment = this.visibleTestPayment(id, token);
    if (!payment) return null;
    if (payment.status === 'paid') return { action: 'redirect', location: buyerUrl(payment.returnUrl, payment) };
    if (payment.status !== 'pending' || !payment.bankUrl) return { action: 'html', status: 409, html: testClosedPage() };
    const action = `/api/pay/test/${payment.id}?t=${encodeURIComponent(token ?? '')}`;
    return {
      action: 'html',
      status: 200,
      html: testCardPage({
        productName: payment.productName,
        amount: payment.amount / 100,
        currency: payment.currency,
        amountAmd: payment.amountAmd ?? testAmdQuote(payment.amount).amountAmd,
        exchangeRate: payment.exchangeRate ?? testAmdQuote(payment.amount).exchangeRate,
        action,
        cancelUrl: `/api/pay/test/${payment.id}/cancel?t=${encodeURIComponent(token ?? '')}`,
      }),
    };
  }

  completeTestCheckout(id: string, token: string | undefined): TestPageResult | null {
    const payment = this.visibleTestPayment(id, token);
    if (!payment) return null;
    if (payment.status === 'pending') markTestPaymentPaid(payment.id, process.env);
    const current = gatewayPaymentById(payment.id, process.env) ?? payment;
    if (current.status !== 'paid') return { action: 'html', status: 409, html: testClosedPage() };
    return { action: 'redirect', location: buyerUrl(current.returnUrl, current) };
  }

  cancelTestCheckout(id: string, token: string | undefined): TestPageResult | null {
    const payment = this.visibleTestPayment(id, token);
    if (!payment) return null;
    if (payment.status === 'paid') return { action: 'redirect', location: buyerUrl(payment.returnUrl, payment) };
    if (payment.status !== 'pending') return { action: 'html', status: 409, html: testClosedPage() };
    return { action: 'redirect', location: buyerUrl(payment.cancelUrl, payment) };
  }

  /** Browser hop after the bank. The provider never receives this address. */
  buyerHandoff(id: string, kind: 'return' | 'cancel'): string | null {
    this.ensureStore();
    const payment = gatewayPaymentById(id, process.env);
    if (!payment) return null;
    return buyerUrl(kind === 'cancel' ? payment.cancelUrl : payment.returnUrl, payment);
  }

  private visibleTestPayment(id: string, token: string | undefined): GatewayPayment | null {
    this.ensureStore();
    const payment = gatewayPaymentById(id, process.env);
    if (!payment || payment.environment !== 'test' || !testTokenMatches(payment.bankUrl, token)) return null;
    return payment;
  }

  private async open(input: CreatePayCheckout, options: PayCheckoutOptions): Promise<PayCheckoutResult> {
    this.ensureStore();
    const settings = resolveSpayonSettings(process.env);
    if (!options.test && !settings.credentials) {
      throw new ServiceUnavailableException('Payment is not configured yet');
    }
    const environment = options.test ? 'test' : settings.environment;
    const currency = (input.currency ?? settings.currency).trim().toUpperCase();
    if (currency !== settings.currency) {
      throw new BadRequestException(`Currency must be ${settings.currency}`);
    }
    const amount = minorUnits(input.amount);
    const returnUrl = customerUrl(input.returnUrl, settings.environment);
    const cancelUrl = customerUrl(input.cancelUrl, settings.environment);
    const reference = input.reference.trim();
    if (!/^[\w.-]{1,80}$/.test(reference)) {
      throw new BadRequestException('Reference must be 1 to 80 letters, numbers, dots, underscores or hyphens');
    }
    const productName = input.productName.trim();
    if (productName.length < 1 || productName.length > 120) {
      throw new BadRequestException('Product name must be 1 to 120 characters');
    }
    const email = input.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      throw new BadRequestException('A valid email is required');
    }
    const fullName = input.fullName?.trim() || null;
    if (fullName && fullName.length > 120) throw new BadRequestException('Name is too long');

    let payment = gatewayPaymentByReference(reference, environment, process.env);
    if (payment && (payment.amount !== amount || payment.currency !== currency)) {
      throw new ConflictException('This reference already exists for a different amount');
    }
    if (payment?.status === 'paid') return view(payment);
    if (payment && (payment.status === 'failed' || payment.status === 'expired')) {
      reopenGatewayPayment(payment.id, process.env);
      payment = gatewayPaymentById(payment.id, process.env);
    }
    if (payment?.bankUrl && payment.status === 'pending') {
      if (environment === 'test') return view(payment);
      return {
        ...view(payment),
        url: validateSpayonBankUrl(payment.bankUrl, settings.environment),
      };
    }
    if (!payment) {
      payment = insertGatewayPayment(
        {
          reference,
          environment,
          productName: PROVIDER_PRODUCT_NAME,
          email,
          fullName,
          amount,
          currency,
          returnUrl,
          cancelUrl,
        },
        process.env,
      );
    }

    if (options.test) return this.attachTestPage(payment, options.origin);

    if (!settings.credentials) {
      throw new ServiceUnavailableException('Payment is not configured yet');
    }
    const request: SpayonCheckoutRequest = {
      product_name: PROVIDER_PRODUCT_NAME,
      price: amount / 100,
      currency,
      order_id: payment.id,
      email,
      full_name: fullName ?? undefined,
      defaultPaymentMethod: 'visamaster',
      callback_url: spayonUrls(process.env, settings.environment).callback,
      return_url: issuePaymentHandoff(buyerUrl(returnUrl, payment), process.env),
      cancel_url: issuePaymentHandoff(buyerUrl(cancelUrl, payment), process.env),
    };
    try {
      const client = new SpayonClient(settings.credentials);
      const sessionId = payment.sessionId ?? (await client.createSession(request)).sessionId;
      if (!payment.sessionId) attachGatewaySession(payment.id, sessionId, null, process.env);
      const checkout = {
        sessionId,
        url: `${settings.environment === 'sandbox' ? 'https://pay.spayon.io/sandbox' : 'https://pay.scoupon.am'}/session/${encodeURIComponent(sessionId)}`,
      };
      const bank = await spayonCardCheckoutUrl(checkout, request, settings.environment);
      attachGatewaySession(payment.id, sessionId, bank.url, process.env, bank);
      return view({
        ...payment,
        status: 'pending',
        bankUrl: bank.url,
        amountAmd: bank.amountAmd,
        exchangeRate: bank.exchangeRate,
      });
    } catch (error) {
      logger.error(`Gateway checkout failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw new BadGatewayException('Could not open the payment. Please try again.');
    }
  }

  private attachTestPage(payment: GatewayPayment, origin: string): PayCheckoutResult {
    const pageOrigin = acceptedOrigin(origin, process.env);
    if (!pageOrigin) throw new BadRequestException('Unexpected payment page host');
    const quote = testAmdQuote(payment.amount);
    const token = randomBytes(18).toString('base64url');
    const url = `${pageOrigin}/api/pay/test/${payment.id}?t=${encodeURIComponent(token)}`;
    attachGatewaySession(payment.id, `test:${payment.id}`, url, process.env, quote);
    return view({
      ...payment,
      status: 'pending',
      bankUrl: url,
      amountAmd: quote.amountAmd,
      exchangeRate: quote.exchangeRate,
    });
  }

  private ensureStore(): void {
    if (this.ready) return;
    const db = new Database(authDatabasePath(process.env));
    try {
      initializeGatewayStore(db);
      this.ready = true;
    } finally {
      db.close();
    }
  }
}

export function view(
  payment: GatewayPayment,
  url: string | null = payment.status === 'pending' ? payment.bankUrl : null,
): PayCheckoutResult {
  return {
    id: payment.id,
    reference: payment.reference,
    status: payment.status,
    amount: payment.amount / 100,
    currency: payment.currency,
    amountAmd: payment.amountAmd,
    exchangeRate: payment.exchangeRate,
    url,
    paidAt: payment.paidAt,
    expiredAt: payment.expiredAt,
  };
}

export function minorUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
    throw new BadRequestException('Amount must be greater than 0 and at most 100000');
  }
  const minor = Math.round(amount * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(amount * 100 - minor) > 0.001) {
    throw new BadRequestException('Amount must have at most two decimal places');
  }
  return minor;
}

function buyerUrl(base: string, payment: GatewayPayment): string {
  const url = new URL(base);
  url.searchParams.set('payment', payment.id);
  url.searchParams.set('reference', payment.reference);
  return url.toString();
}

function customerUrl(value: string, environment: 'sandbox' | 'production'): string {
  return parseUrl(value, environment === 'production');
}

function parseUrl(value: string, httpsOnly: boolean): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException('Return and cancel URLs must be absolute');
  }
  if (url.username || url.password || url.hash) throw new BadRequestException('URLs must not contain credentials');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'https:' && !privateAddress(url.hostname)) return url.toString();
  if (!httpsOnly && url.protocol === 'http:' && loopback) return url.toString();
  throw new BadRequestException('Customer URLs must be public HTTPS addresses');
}

function privateAddress(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return hostname === 'localhost' || hostname.endsWith('.localhost');
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
