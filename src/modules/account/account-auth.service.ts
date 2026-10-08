import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { IncomingHttpHeaders } from 'http';
import { createLogger } from '../../common/services/logger.service';
import { Session } from '../session/entities/session.entity';
import { ApiKey } from '../auth/entities/api-key.entity';
import { accountUserIdOf, syntheticAccountKey } from './account-actor';
import { isBillingExemptApiPath, resolveBillingAccess } from './account-billing';
import { loadAuthUserBillingRow } from './account-billing-user';
import { startAuth } from './auth';
import type { Request } from 'express';

/**
 * Turns a Better Auth cookie into the API-key actor the rest of OpenWA already understands,
 * and keeps that account's WhatsApp sessions as the only ones it can see.
 */
@Injectable()
export class AccountAuthService implements OnModuleInit {
  private readonly logger = createLogger('AccountAuth');

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Jest compiles this package to CommonJS and cannot load the ESM-only better-auth module.
    // The running server (Node, including the Dokploy image) loads it via dynamic import().
    if (process.env.JEST_WORKER_ID) return;
    const started = await startAuth();
    this.logger.log('Better Auth schema is ready');
    if (!started.passwordReset) {
      this.logger.warn('Password reset is off until RESEND_API_KEY is set');
    }
    if (started.emailVerification) {
      this.logger.log('Sign-up email verification (OTP) is enabled via Resend');
    }
    if (started.stripe) {
      this.logger.log('Stripe billing is enabled');
    } else if (!started.polar) {
      this.logger.warn('Billing is off until STRIPE_SECRET_KEY + STRIPE_PRICE_ID or POLAR_ACCESS_TOKEN is set');
    } else if (!started.polarWebhooks) {
      this.logger.log('Polar checkout is ready. Set POLAR_WEBHOOK_SECRET to receive subscription events.');
    } else {
      this.logger.log('Polar checkout and webhooks are ready');
    }
  }

  async actorFromHeaders(headers: IncomingHttpHeaders): Promise<ApiKey | null> {
    if (process.env.JEST_WORKER_ID) return null;
    const { auth, fromNodeHeaders } = await startAuth();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session?.user) return null;
    const role = (session.user as { role?: string }).role === 'admin' ? 'admin' : 'user';
    const sessionIds =
      role === 'admin'
        ? null
        : (await this.sessions.find({ select: { id: true }, where: { ownerUserId: session.user.id } })).map(
            row => row.id,
          );
    return syntheticAccountKey({
      id: session.user.id,
      email: session.user.email,
      role,
      sessionIds,
    });
  }

  /** Blocks dashboard account traffic after the free trial when Polar billing is on and there is no subscription. */
  async assertAccountOwnsSession(accountUserId: string, sessionId: string): Promise<void> {
    const owned = await this.sessions.exists({ where: { id: sessionId, ownerUserId: accountUserId } });
    if (!owned) {
      throw new ForbiddenException('Not authorized for this session');
    }
  }

  async assertAccountBillingAccess(request: Request, apiKey: ApiKey, usedApiKeyHeader: boolean): Promise<void> {
    if (usedApiKeyHeader || !accountUserIdOf(apiKey)) return;
    const path = request.path ?? request.url ?? '';
    if (isBillingExemptApiPath(path)) return;

    const { auth, fromNodeHeaders } = await startAuth();
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session?.user) return;

    const billingRow = loadAuthUserBillingRow(session.user.id, process.env);
    const access = await resolveBillingAccess(
      {
        id: session.user.id,
        role: billingRow?.role ?? (session.user as { role?: string }).role,
        createdAt: billingRow?.createdAt ?? session.user.createdAt,
        subscriptionStatus: billingRow?.subscriptionStatus,
        stripeCustomerId: billingRow?.stripeCustomerId,
      },
      process.env,
    );
    if (access.paymentRequired) {
      throw new ForbiddenException('An active subscription is required. Open Billing to subscribe.');
    }
  }
}
