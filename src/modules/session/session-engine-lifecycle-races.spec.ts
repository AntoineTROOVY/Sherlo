import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
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
});
