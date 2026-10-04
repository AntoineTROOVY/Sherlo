import { FindOperator, Repository } from 'typeorm';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { MAX_WEBHOOK_REDRIVE_LIMIT, WebhookRedriveService } from './webhook-redrive.service';

const failure = (overrides: Partial<WebhookDeliveryFailure> = {}): WebhookDeliveryFailure => ({
  id: 'f-1',
  webhookId: 'wh-1',
  sessionId: 'sess-1',
  event: 'message.received',
  url: 'https://r.example/h',
  idempotencyKey: 'key-1',
  deliveryId: 'd-1',
  attempts: 3,
  lastStatusCode: 503,
  lastError: 'HTTP 503: x',
  payload: { id: 'msg-1', body: 'hi' },
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

const webhook = (overrides: Partial<Webhook> = {}): Webhook =>
  ({
    id: 'wh-1',
    sessionId: 'sess-1',
    url: 'https://r.example/h',
    events: ['message.received'],
    active: true,
    retryCount: 3,
    ...overrides,
  }) as Webhook;

describe('WebhookRedriveService', () => {
  let failures: { find: jest.Mock; count: jest.Mock; update: jest.Mock };
  let webhooks: { find: jest.Mock };
  let delivery: { redeliver: jest.Mock };
  let service: WebhookRedriveService;

  beforeEach(() => {
    failures = {
      find: jest.fn().mockResolvedValue([failure()]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    webhooks = { find: jest.fn().mockResolvedValue([webhook()]) };
    delivery = { redeliver: jest.fn().mockResolvedValue('delivered') };
    service = new WebhookRedriveService(
      webhooks as unknown as Repository<Webhook>,
      failures as unknown as Repository<WebhookDeliveryFailure>,
      delivery as unknown as WebhookDeliveryService,
    );
  });

  const findArgs = (): {
    select: Record<string, boolean>;
    where: Record<string, unknown>;
    take: number;
    order: Record<string, string>;
  } => (failures.find.mock.calls as unknown[][])[0][0] as ReturnType<typeof findArgs>;

  it('replays a stored row with its STORED idempotency key, one attempt, and reports it delivered', async () => {
    const result = await service.redrive({});

    expect(delivery.redeliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wh-1' }),
      'sess-1',
      'message.received',
      'key-1',
      { id: 'msg-1', body: 'hi' },
      { singleAttempt: true },
    );
    expect(result).toEqual({ redriven: 1, delivered: 1, enqueued: 0, failed: 0, skipped: 0, remaining: 0 });
  });

  it('reads the select:false payload explicitly, takes only terminal keyed rows, oldest first', async () => {
    await service.redrive({});

    const args = findArgs();
    expect(args.select.payload).toBe(true);
    expect(args.where.attempts).toBeInstanceOf(FindOperator);
    expect((args.where.attempts as FindOperator<number>).type).toBe('moreThan');
    expect((args.where.payload as FindOperator<unknown>).type).toBe('not');
    expect((args.where.idempotencyKey as FindOperator<unknown>).type).toBe('not');
    expect(args.order).toEqual({ createdAt: 'ASC', id: 'ASC' });
    expect(args.take).toBe(100);
  });

  it('clamps the limit to the maximum batch', async () => {
    await service.redrive({ limit: 10_000 });
    expect(findArgs().take).toBe(MAX_WEBHOOK_REDRIVE_LIMIT);
  });

  it('confines a scoped key to its allowedSessions, and a sessionId outside them to nothing', async () => {
    await service.redrive({}, ['sess-1', 'sess-2']);
    expect((findArgs().where.sessionId as FindOperator<string[]>).value).toEqual(['sess-1', 'sess-2']);

    failures.find.mockClear();
    const result = await service.redrive({ sessionId: 'sess-9' }, ['sess-1']);
    expect(failures.find).not.toHaveBeenCalled();
    expect(delivery.redeliver).toHaveBeenCalledTimes(1);
    expect(result.redriven).toBe(0);
  });

  it('narrows by webhookId and explicit ids', async () => {
    await service.redrive({ webhookId: 'wh-1', ids: ['f-1', 'f-2'] });
    const where = findArgs().where;
    expect(where.webhookId).toBe('wh-1');
    expect((where.id as FindOperator<string[]>).value).toEqual(['f-1', 'f-2']);
  });

  it('skips a row whose webhook is gone, disabled, unsubscribed or now owned by another session', async () => {
    failures.find.mockResolvedValue([
      failure({ id: 'a', webhookId: 'gone' }),
      failure({ id: 'b', webhookId: 'off' }),
      failure({ id: 'c', webhookId: 'unsub' }),
      failure({ id: 'd', webhookId: 'moved' }),
    ]);
    webhooks.find.mockResolvedValue([
      webhook({ id: 'off', active: false }),
      webhook({ id: 'unsub', events: ['message.ack'] }),
      webhook({ id: 'moved', sessionId: 'sess-2' }),
    ]);

    const result = await service.redrive({});

    expect(delivery.redeliver).not.toHaveBeenCalled();
    expect(result.skipped).toBe(4);
  });

  it('counts enqueued and cancelled outcomes, and raises attempts on a replay that fails again', async () => {
    failures.find.mockResolvedValue([
      failure({ id: 'a', attempts: 3 }),
      failure({ id: 'b', attempts: 5 }),
      failure({ id: 'c' }),
      failure({ id: 'd', attempts: 2 }),
    ]);
    delivery.redeliver
      .mockResolvedValueOnce('enqueued')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('cancelled')
      .mockRejectedValueOnce(new Error('boom'));
    failures.count.mockResolvedValue(2);

    const result = await service.redrive({});

    expect(result).toEqual({ redriven: 1, delivered: 0, enqueued: 1, failed: 2, skipped: 1, remaining: 2 });
    expect(failures.update).toHaveBeenCalledWith({ id: 'b' }, { attempts: 6 });
    expect(failures.update).toHaveBeenCalledWith({ id: 'd' }, { attempts: 3 });
    expect(failures.update).toHaveBeenCalledTimes(2);
  });

  it('keeps the batch going when recording a failed replay fails', async () => {
    failures.find.mockResolvedValue([failure({ id: 'a' }), failure({ id: 'b' })]);
    delivery.redeliver.mockResolvedValueOnce('failed').mockResolvedValueOnce('delivered');
    failures.update.mockRejectedValue(new Error('db down'));

    const result = await service.redrive({});

    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(1);
  });

  it('runs overlapping calls one after the other, and survives a failed batch', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    delivery.redeliver.mockImplementationOnce(async () => {
      await gate;
      return 'delivered';
    });
    failures.find.mockRejectedValueOnce(new Error('db down')).mockResolvedValue([failure()]);

    const first = service.redrive({});
    await expect(first).rejects.toThrow('db down');

    const second = service.redrive({});
    const third = service.redrive({});
    await new Promise(resolve => setImmediate(resolve));
    // The third call has not read anything while the second is still replaying.
    expect(failures.find).toHaveBeenCalledTimes(2);
    release();
    await expect(second).resolves.toMatchObject({ delivered: 1 });
    await expect(third).resolves.toMatchObject({ delivered: 1 });
    expect(failures.find).toHaveBeenCalledTimes(3);
  });

  it('does not read webhooks when nothing is replayable', async () => {
    failures.find.mockResolvedValue([]);
    failures.count.mockResolvedValue(0);

    const result = await service.redrive({});

    expect(webhooks.find).not.toHaveBeenCalled();
    expect(result).toEqual({ redriven: 0, delivered: 0, enqueued: 0, failed: 0, skipped: 0, remaining: 0 });
  });
});
