import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { SessionStoppedException } from './session-engine-controls';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';
import { SessionEngineLifecycle, type ReconnectState } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';
import { Session, SessionStatus } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { MessageProjector } from './message-projector.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';

const ID = 'sess-uuid-1';
const NAME = 'test-session';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: ID,
  name: NAME,
  status: SessionStatus.CREATED,
  phone: null,
  pushName: null,
  config: {},
  proxyUrl: null,
  proxyType: null,
  connectedAt: null,
  lastActiveAt: null,
  nodeId: null,
  claimedAt: null,
  leaseExpiresAt: null,
  desiredState: null,
  nodeUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeEngine = (): Record<string, jest.Mock> => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  forceDestroy: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  logout: jest.fn().mockResolvedValue(undefined),
  getQRCode: jest.fn().mockReturnValue(null),
});

/** A promise the test settles by hand. */
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

interface Internals {
  engines: EngineRegistry;
  reconnectStates: Map<string, ReconnectState>;
  logger: { warn: (...args: unknown[]) => void };
  executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void>;
  scheduleReconnect(id: string, session: Session): void;
  rejectRebind(id: string, engine: unknown, name: string, previous: string, incoming: string): Promise<void>;
}

describe('SessionEngineLifecycle races', () => {
  let lifecycle: SessionEngineLifecycle;
  let internals: Internals;
  let repository: { findOne: jest.Mock; update: jest.Mock; exists: jest.Mock };
  let engineFactory: { create: jest.Mock; purgeSessionData: jest.Mock };
  let config: Record<string, unknown>;

  beforeEach(async () => {
    config = {};
    repository = {
      findOne: jest.fn().mockResolvedValue(session()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      exists: jest.fn().mockResolvedValue(false),
    };
    engineFactory = {
      create: jest.fn().mockImplementation(() => makeEngine()),
      purgeSessionData: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        SessionService,
        SessionEngineLifecycle,
        SessionErrorStore,
        SessionRestrictionStore,
        PresenceStore,
        { provide: getRepositoryToken(Session, 'data'), useValue: repository },
        { provide: getRepositoryToken(Message, 'data'), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getDataSourceToken('data'), useValue: {} },
        { provide: EngineFactory, useValue: engineFactory },
        EngineRegistry,
        SessionLidResolver,
        SessionLivenessWatchdog,
        MessageProjector,
        {
          provide: EventsGateway,
          useValue: { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn(), emitQRCode: jest.fn() },
        },
        { provide: WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
        { provide: HookManager, useValue: { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(<T>(key: string, def?: T): T => (key in config ? (config[key] as T) : (def as T))) },
        },
        { provide: LidMappingStoreService, useValue: { remember: jest.fn() } },
        { provide: StatusStoreService, useValue: { ingest: jest.fn() } },
      ],
    }).compile();
    lifecycle = module.get(SessionEngineLifecycle);
    internals = lifecycle as unknown as Internals;
  });

  afterEach(() => {
    for (const state of internals.reconnectStates.values()) if (state.timer) clearTimeout(state.timer);
  });

  describe('MAX_CONCURRENT_SESSIONS', () => {
    it('counts a session waiting out a failed relaunch, which holds no engine', async () => {
      config['sessions.maxConcurrent'] = 1;
      const timer = setTimeout(() => undefined, 60_000);
      internals.reconnectStates.set('other', { attempts: 1, timer, maxAttempts: 5, baseDelay: 5000 });

      await expect(lifecycle.start(ID)).rejects.toThrow(
        new BadRequestException('Maximum concurrent sessions reached (1)'),
      );
      expect(engineFactory.create).not.toHaveBeenCalled();
    });

    it('does not count the reconnect state of the session being started', async () => {
      config['sessions.maxConcurrent'] = 1;
      const timer = setTimeout(() => undefined, 60_000);
      internals.reconnectStates.set(ID, { attempts: 1, timer, maxAttempts: 5, baseDelay: 5000 });

      await lifecycle.start(ID);

      expect(internals.engines.has(ID)).toBe(true);
    });
  });

  describe('stopOrphanEngines against a start still reading its row', () => {
    it('retires the start instead of letting it clear the stop mark', async () => {
      const read = deferred<Session>();
      repository.findOne.mockReturnValueOnce(read.promise);

      const starting = lifecycle.start(ID);
      const outcome = starting.then(
        () => undefined,
        (e: unknown) => e,
      );
      await flush();
      await expect(lifecycle.stopOrphanEngines([ID])).resolves.toEqual({
        stopped: [],
        notRunning: [ID],
        failed: [],
      });
      read.resolve(session());

      expect(await outcome).toBeInstanceOf(SessionStoppedException);
      expect(engineFactory.create).not.toHaveBeenCalled();
      expect(internals.engines.has(ID)).toBe(false);
    });

    it('still clears a stop mark left from before the start began', async () => {
      await lifecycle.stopOrphanEngines([ID]);

      await lifecycle.start(ID);

      expect(internals.engines.has(ID)).toBe(true);
    });
  });

  describe('rejectRebind', () => {
    const failedWrites = (): number =>
      repository.update.mock.calls.filter(
        ([, patch]) => (patch as { status?: unknown }).status === SessionStatus.FAILED,
      ).length;

    it("retires the refused account's engine before its logout runs", async () => {
      const logout = deferred();
      const engine = { ...makeEngine(), logout: jest.fn().mockReturnValue(logout.promise) };
      internals.engines.set(ID, engine as never);

      const rejecting = internals.rejectRebind(ID, engine, NAME, '628111', '628999');
      await flush();

      // Every inbound callback is gated on this, so nothing the refused account sends while the
      // logout runs is stored or dispatched under this session.
      expect(engine.logout).toHaveBeenCalledTimes(1);
      expect(internals.engines.isLive(ID, engine as never)).toBe(false);

      logout.resolve();
      await rejecting;
      expect(failedWrites()).toBe(1);
    });

    it('leaves a start that registered an engine during the logout alone', async () => {
      const logout = deferred();
      const engine = { ...makeEngine(), logout: jest.fn().mockReturnValue(logout.promise) };
      const replacement = makeEngine();
      internals.engines.set(ID, engine as never);

      const rejecting = internals.rejectRebind(ID, engine, NAME, '628111', '628999');
      await flush();
      internals.engines.set(ID, replacement as never);
      logout.resolve();
      await rejecting;

      expect(internals.engines.get(ID)).toBe(replacement);
      expect(failedWrites()).toBe(0);
    });
  });

  describe('engine-driven status writes', () => {
    const rejectStatus = (status: SessionStatus): void => {
      repository.update.mockImplementation((_id: unknown, patch: { status?: unknown }) =>
        patch.status === status ? Promise.reject(new Error('SQLITE_BUSY')) : Promise.resolve({ affected: 1 }),
      );
    };

    it('logs a failed DISCONNECTED write instead of leaving it unhandled', async () => {
      const warn = jest.spyOn(internals.logger, 'warn');
      rejectStatus(SessionStatus.DISCONNECTED);
      const engine = makeEngine();
      internals.engines.set(ID, engine as never);

      await lifecycle.handleEngineDisconnected(ID, engine as never, 'NAVIGATION');
      await flush();

      expect(warn).toHaveBeenCalledWith('Failed to persist the disconnected status', {
        sessionId: ID,
        error: 'SQLITE_BUSY',
      });
    });

    it('logs a failed FAILED write when reconnect attempts run out', async () => {
      const warn = jest.spyOn(internals.logger, 'warn');
      rejectStatus(SessionStatus.FAILED);
      internals.reconnectStates.set(ID, { attempts: 5, timer: null, maxAttempts: 5, baseDelay: 5000 });

      internals.scheduleReconnect(ID, session());
      await flush();

      expect(warn).toHaveBeenCalledWith('Failed to persist the reconnect-exhausted FAILED state', {
        sessionId: ID,
        error: 'SQLITE_BUSY',
      });
    });
  });
});
