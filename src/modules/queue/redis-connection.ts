import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { redisConnectionOptions, type RedisConnectionOptions } from '../../config/redis-options';

/**
 * BullMQ connection for the shared producer (`BullModule.forRootAsync` in queue.module.ts): the common
 * Redis fields plus `enableOfflineQueue: false`, so `queue.add()` fails fast when Redis is unreachable
 * and the dispatch path can fall back to direct delivery instead of buffering forever.
 */
export function queueConnectionOptions(): RedisConnectionOptions & { enableOfflineQueue: false } {
  return { ...redisConnectionOptions(), enableOfflineQueue: false };
}

/**
 * BullMQ connection for the webhook and ingress Workers. It must NOT inherit the producer-only
 * fast-fail above: the Worker's blocking/internal commands (moveToActive, lock renewal) need to
 * tolerate a brief reconnect during a Redis blip/failover, and BullMQ recommends leaving the offline
 * queue enabled for Worker connections. @nestjs/bullmq would otherwise build the Worker from the shared
 * connection, so each processor passes these options instead; without the override a transient outage
 * throws "Stream isn't writeable" and stalls jobs.
 */
export function workerConnectionOptions(): RedisConnectionOptions {
  return redisConnectionOptions();
}

/** Default number of webhook deliveries the Worker processes in parallel. */
const DEFAULT_WEBHOOK_WORKER_CONCURRENCY = 10;

/**
 * Webhook Worker concurrency. BullMQ defaults a Worker to 1, which serializes ALL webhook deliveries
 * process-wide: one slow or timing-out receiver head-of-line-blocks every other session's webhooks
 * until it finishes (up to WEBHOOK_TIMEOUT + retries). Running several in parallel lets healthy
 * receivers proceed while a few slots wait on a stuck one, but the pool is shared and not isolated
 * per webhook: each attempt against a dead receiver holds a slot for up to WEBHOOK_TIMEOUT, and its
 * retries re-enter the same pool. Once that receiver's events per second x attempts x
 * WEBHOOK_TIMEOUT (in seconds) reach the concurrency, every slot is busy with it and all other
 * webhooks wait. Size the value above that product. Override via WEBHOOK_WORKER_CONCURRENCY; a
 * non-positive/garbage value falls back to the default. (Read at module import like
 * workerConnectionOptions above.)
 */
export function webhookWorkerConcurrency(): number {
  return resolveNonNegativeIntEnv(process.env.WEBHOOK_WORKER_CONCURRENCY, 0) || DEFAULT_WEBHOOK_WORKER_CONCURRENCY;
}

/** Default number of ingress events the Worker processes in parallel. */
const DEFAULT_INGRESS_WORKER_CONCURRENCY = 10;

/**
 * Ingress Worker concurrency. Ordering within a conversation is now guaranteed by the
 * per-conversation KeyedAsyncLock in the processor, not by a single-worker queue, so raising
 * concurrency here parallelizes unrelated conversations. A job waiting on a busy key still holds a
 * slot, though: a burst on one key larger than this value blocks every other key until it drains.
 * Size it above the largest expected per-key burst; the key is the whole instance unless the route
 * declares a conversationId pointer. Override via INGRESS_WORKER_CONCURRENCY; a
 * non-positive/garbage value falls back to the default.
 */
export function ingressWorkerConcurrency(): number {
  return resolveNonNegativeIntEnv(process.env.INGRESS_WORKER_CONCURRENCY, 0) || DEFAULT_INGRESS_WORKER_CONCURRENCY;
}
