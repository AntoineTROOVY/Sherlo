import { IngressProcessor } from './ingress.processor';

function job(overrides = {}) {
  return {
    data: {
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      deliveryId: 'd1',
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as never;
}

describe('IngressProcessor', () => {
  it('dispatches the event into the worker via dispatchWebhook', async () => {
    const dispatchWebhook = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const loader = { dispatchWebhookForInstance: dispatchWebhook };
    const failures = { save: jest.fn() };
    const proc = new IngressProcessor(loader as never, failures as never, { execute: jest.fn() } as never, {} as never);
    await proc.process(job());
    expect(dispatchWebhook).toHaveBeenCalled();
  });

  it('records a DLQ failure row and fires ingress:error on the final attempt', async () => {
    const loader = { dispatchWebhookForInstance: jest.fn().mockRejectedValue(new Error('boom')) };
    const failures = { save: jest.fn().mockResolvedValue(undefined) };
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
    const proc = new IngressProcessor(loader as never, failures as never, hooks as never, {} as never);
    await expect(proc.process(job({ attemptsMade: 2, opts: { attempts: 3 } }))).rejects.toThrow('boom');
    expect(failures.save).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'inbound', deliveryId: 'd1', pluginId: 'chatwoot' }),
    );
    expect(hooks.execute).toHaveBeenCalledWith('ingress:error', expect.anything(), expect.anything());
  });

  // Once the attempts are spent the DLQ row is the only durable copy: the ingress_events row retired its
  // payload on 'queued' and removeOnFail prunes the failed job. A data database that is down for the
  // whole retry window refuses the row too, so the delivery goes back on the queue instead.
  it('re-queues the delivery when the final-attempt DLQ write fails, and still rethrows the dispatch error', async () => {
    const loader = { dispatchWebhookForInstance: jest.fn().mockRejectedValue(new Error('boom')) };
    const failures = { save: jest.fn().mockRejectedValue(new Error('db down')) };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const proc = new IngressProcessor(
      loader as never,
      failures as never,
      { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
      queue as never,
    );
    const failed = job({ id: 'ing-abc', name: 'ingress', attemptsMade: 2, opts: { attempts: 3 } });

    await expect(proc.process(failed)).rejects.toThrow('boom');

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0] as [string, unknown, { jobId: string; attempts: number }];
    expect(name).toBe('ingress');
    expect(data).toEqual((failed as { data: unknown }).data);
    expect(opts).toEqual(expect.objectContaining({ attempts: 3, delay: expect.any(Number) as unknown }));
    // A fresh id: the retained failed job still holds the original one, and BullMQ would dedup onto it.
    expect(opts.jobId).toMatch(/^ing-abc-requeued-\d+$/);

    // Re-queued again through a long outage, the id keeps a single suffix.
    queue.add.mockClear();
    await expect(
      proc.process(job({ id: opts.jobId, name: 'ingress', attemptsMade: 2, opts: { attempts: 3 } })),
    ).rejects.toThrow('boom');
    expect((queue.add.mock.calls[0] as [string, unknown, { jobId: string }])[2].jobId).toMatch(
      /^ing-abc-requeued-\d+$/,
    );
  });

  it('rethrows on a non-final attempt without recording a DLQ row or firing ingress:error', async () => {
    const loader = { dispatchWebhookForInstance: jest.fn().mockRejectedValue(new Error('boom')) };
    const failures = { save: jest.fn().mockResolvedValue(undefined) };
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
    const proc = new IngressProcessor(loader as never, failures as never, hooks as never, {} as never);
    await expect(proc.process(job({ attemptsMade: 0, opts: { attempts: 3 } }))).rejects.toThrow('boom');
    expect(failures.save).not.toHaveBeenCalled();
    expect(hooks.execute).not.toHaveBeenCalled();
  });

  it('serializes two jobs for the same conversation and parallelizes different ones', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const loader = {
      dispatchWebhookForInstance: jest.fn(async (d: { deliveryId: string }) => {
        started.push(d.deliveryId);
        await new Promise(r => setTimeout(r, d.deliveryId === 'same-1' ? 20 : 1));
        finished.push(d.deliveryId);
      }),
    };
    const proc = new IngressProcessor(
      loader as never,
      { save: jest.fn() } as never,
      { execute: jest.fn() } as never,
      {} as never,
    );
    const mk = (deliveryId: string, convo: string) =>
      proc.process({
        data: {
          pluginId: 'p',
          instanceId: 'i',
          route: 'r',
          deliveryId,
          providerConversationId: convo,
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never);
    await Promise.all([mk('same-1', 'c1'), mk('same-2', 'c1')]);
    // Same conversation → same-1 finishes before same-2 starts.
    expect(finished.indexOf('same-1')).toBeLessThan(started.indexOf('same-2'));
  });

  it('parallelizes jobs for different conversations', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const loader = {
      dispatchWebhookForInstance: jest.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 10));
        concurrent--;
      }),
    };
    const proc = new IngressProcessor(
      loader as never,
      { save: jest.fn() } as never,
      { execute: jest.fn() } as never,
      {} as never,
    );
    const mk = (deliveryId: string, convo: string) =>
      proc.process({
        data: {
          pluginId: 'p',
          instanceId: 'i',
          route: 'r',
          deliveryId,
          providerConversationId: convo,
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never);
    await Promise.all([mk('d1', 'c1'), mk('d2', 'c2'), mk('d3', 'c3')]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});

// BullMQ fails a job that stalls more than maxStalledCount WITHOUT calling process(), then emits
// 'failed'. The ingress row already retired its payload on 'queued', so the DLQ row is the only copy.
describe('IngressProcessor stall exhaustion (worker failed event)', () => {
  const STALLED = new Error('job stalled more than allowable limit');
  const setup = () => {
    const failures = { save: jest.fn().mockResolvedValue(undefined) };
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const proc = new IngressProcessor({} as never, failures as never, hooks as never, queue as never);
    return { proc, failures, hooks, queue };
  };

  it('records one inbound DLQ row with the full payload and fires ingress:error', async () => {
    const { proc, failures, hooks } = setup();
    await proc.onWorkerFailed(job({ attemptsMade: 1 }), STALLED);
    expect(failures.save).toHaveBeenCalledTimes(1);
    expect(failures.save).toHaveBeenCalledWith({
      direction: 'inbound',
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      sessionId: null,
      deliveryId: 'd1',
      attempts: 1,
      lastError: 'job stalled more than allowable limit',
      payload: {
        route: 'chatwoot',
        method: undefined,
        providerConversationId: undefined,
        ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      },
      redriven: false,
    });
    expect(hooks.execute).toHaveBeenCalledWith(
      'ingress:error',
      expect.objectContaining({ deliveryId: 'd1', error: 'job stalled more than allowable limit' }),
      expect.anything(),
    );
  });

  it('ignores any other failure (process() already recorded it) and a pruned job', async () => {
    const { proc, failures, hooks } = setup();
    await proc.onWorkerFailed(job({ attemptsMade: 3 }), new Error('boom'));
    await proc.onWorkerFailed(undefined, STALLED);
    expect(failures.save).not.toHaveBeenCalled();
    expect(hooks.execute).not.toHaveBeenCalled();
  });

  it('re-queues instead of rejecting when the DLQ write fails (an event listener must not reject)', async () => {
    const { proc, failures, queue } = setup();
    failures.save.mockRejectedValue(new Error('db down'));
    await expect(proc.onWorkerFailed(job({ id: 'ing-abc', name: 'ingress' }), STALLED)).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('still resolves when neither the DLQ write nor the re-queue succeeds', async () => {
    const { proc, failures, queue } = setup();
    failures.save.mockRejectedValue(new Error('db down'));
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(proc.onWorkerFailed(job({ id: 'ing-abc', name: 'ingress' }), STALLED)).resolves.toBeUndefined();
  });
});
