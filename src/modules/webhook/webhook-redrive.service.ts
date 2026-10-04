import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { isDeliverableWebhook } from './utils/deliver-once';
import { resolveSessionScope } from '../../common/security/session-scope';
import { createLogger } from '../../common/services/logger.service';

/** Rows replayed per call when the caller names no limit, and the most one call will take. */
export const DEFAULT_WEBHOOK_REDRIVE_LIMIT = 100;
export const MAX_WEBHOOK_REDRIVE_LIMIT = 500;

/**
 * Replays run this many at a time. Each direct replay is one POST bounded by WEBHOOK_TIMEOUT, so a
 * full batch against a receiver that times out finishes in about limit / 4 timeouts rather than
 * limit of them, without opening a socket per row.
 */
const REDRIVE_CONCURRENCY = 4;

export interface WebhookRedriveRequest {
  sessionId?: string;
  webhookId?: string;
  ids?: string[];
  limit?: number;
}

export interface WebhookRedriveResult {
  /** Rows replayed by this call: delivered plus enqueued. */
  redriven: number;
  /** Delivered by a direct POST; their failure rows are gone. */
  delivered: number;
  /** Handed to the queue; the row is removed when the job delivers, and kept when it fails again. */
  enqueued: number;
  /** The replay failed again; the row stays, with its attempt count raised. */
  failed: number;
  /** Not replayed: the webhook was removed, disabled or unsubscribed, or a plugin cancelled it. */
  skipped: number;
  /** Replayable rows still in scope after this call. */
  remaining: number;
}

/**
 * Operator redrive of lost outbound webhook deliveries: the outbound twin of the integration
 * RedriveService. A terminal row of webhook_delivery_failures keeps the pre-hook event data while
 * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0; this replays those rows through
 * WebhookDeliveryService.redeliver with the STORED idempotency key, so a receiver that already
 * processed the event (the POST timed out after it was handled) dedups the replay instead of
 * acting twice. `webhook:before` hooks run again, as on a reconciler replay.
 *
 * A replay that succeeds removes its own row (the delivery path clears every failure row of the
 * key). One that fails again keeps the row: the recorder files one row per lost delivery, so the
 * replay only raises its attempt count.
 */
@Injectable()
export class WebhookRedriveService {
  private readonly logger = createLogger('WebhookRedrive');
  /**
   * One redrive at a time on this node, so two overlapping calls (a double click, a retrying script)
   * do not replay the same rows side by side. Across nodes a duplicate replay carries the same
   * idempotency key, which the receiver dedups on.
   */
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  redrive(request: WebhookRedriveRequest, allowedSessions?: string[] | null): Promise<WebhookRedriveResult> {
    const run = this.running.then(() => this.redriveBatch(request, allowedSessions));
    // The chain must survive a failed batch, or every later call would inherit its rejection.
    this.running = run.catch(() => undefined);
    return run;
  }

  private async redriveBatch(
    request: WebhookRedriveRequest,
    allowedSessions?: string[] | null,
  ): Promise<WebhookRedriveResult> {
    const result: WebhookRedriveResult = {
      redriven: 0,
      delivered: 0,
      enqueued: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
    };
    // The calling key's allowedSessions is authoritative; the body's sessionId may only narrow it.
    const sessionScope = resolveSessionScope(allowedSessions, request.sessionId);
    if (sessionScope !== null && sessionScope.length === 0) return result;

    // Replayable: terminal (an attempts-0 row is the outbox's to replay), with a stored payload and
    // the key the receiver dedups on.
    const where: FindOptionsWhere<WebhookDeliveryFailure> = {
      attempts: MoreThan(0),
      payload: Not(IsNull()),
      idempotencyKey: Not(IsNull()),
      ...(sessionScope ? { sessionId: In(sessionScope) } : {}),
      ...(request.webhookId ? { webhookId: request.webhookId } : {}),
    };
    const limit = Math.min(Math.max(1, request.limit ?? DEFAULT_WEBHOOK_REDRIVE_LIMIT), MAX_WEBHOOK_REDRIVE_LIMIT);
    const rows = await this.failureRepository.find({
      // `payload` is select: false on the entity; name every column so it is read here.
      select: {
        id: true,
        webhookId: true,
        sessionId: true,
        event: true,
        url: true,
        idempotencyKey: true,
        deliveryId: true,
        attempts: true,
        lastStatusCode: true,
        lastError: true,
        payload: true,
        createdAt: true,
      },
      where: request.ids?.length ? { ...where, id: In(request.ids) } : where,
      // Oldest first: the order the events were lost in.
      order: { createdAt: 'ASC', id: 'ASC' },
      take: limit,
    });

    if (rows.length > 0) {
      const webhookIds = [...new Set(rows.map(r => r.webhookId))];
      const webhooks = new Map(
        (await this.webhookRepository.find({ where: { id: In(webhookIds) } })).map(w => [w.id, w] as const),
      );
      const queue = [...rows];
      const worker = async (): Promise<void> => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          await this.redriveRow(row, webhooks.get(row.webhookId) ?? null, result);
        }
      };
      await Promise.all(Array.from({ length: Math.min(REDRIVE_CONCURRENCY, rows.length) }, worker));
    }

    result.redriven = result.delivered + result.enqueued;
    result.remaining = await this.failureRepository.count({ where });
    return result;
  }

  private async redriveRow(
    row: WebhookDeliveryFailure,
    webhook: Webhook | null,
    result: WebhookRedriveResult,
  ): Promise<void> {
    // The row's own session must still own the webhook: a row is never replayed into another session.
    if (!webhook || webhook.sessionId !== row.sessionId || !isDeliverableWebhook(webhook, row.event)) {
      result.skipped++;
      return;
    }
    try {
      const outcome = await this.delivery.redeliver(
        webhook,
        row.sessionId,
        row.event,
        row.idempotencyKey,
        row.payload ?? {},
        { singleAttempt: true },
      );
      if (outcome === 'delivered') result.delivered++;
      else if (outcome === 'enqueued') result.enqueued++;
      else if (outcome === 'cancelled') result.skipped++;
      else {
        result.failed++;
        await this.bumpAttempts(row);
      }
    } catch (error) {
      result.failed++;
      this.logger.error('Webhook redrive failed', error instanceof Error ? error.message : String(error), {
        webhookId: row.webhookId,
        failureId: row.id,
        action: 'webhook_redrive_error',
      });
      await this.bumpAttempts(row);
    }
  }

  /** Count the failed replay on the row. Best-effort: the row is already on record either way. */
  private async bumpAttempts(row: WebhookDeliveryFailure): Promise<void> {
    try {
      await this.failureRepository.update({ id: row.id }, { attempts: row.attempts + 1 });
    } catch (error) {
      this.logger.warn('Could not record a failed webhook redrive on its row', {
        failureId: row.id,
        error: error instanceof Error ? error.message : String(error),
        action: 'webhook_redrive_bookkeeping_failed',
      });
    }
  }
}
