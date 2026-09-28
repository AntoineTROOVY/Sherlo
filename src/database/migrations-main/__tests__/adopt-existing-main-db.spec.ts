import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ApiKey } from '../../../modules/auth/entities/api-key.entity';
import { AuditLog } from '../../../modules/audit/entities/audit-log.entity';
import { mainConnectionOptions } from '../../main-connection';

/**
 * The main connection runs its migration chain by default. Existing installs have a main.sqlite
 * built by synchronize and no migrations ledger, so the first boot must adopt that file in place:
 * keep every row, add the columns an older release lacked, record the chain, and leave one index
 * per indexed column.
 */
describe('main connection adopts an existing main.sqlite', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openwa-main-'));
    file = join(dir, 'main.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SHIPPED = readdirSync(join(__dirname, '..'))
    .filter(name => name.endsWith('.ts'))
    .map(name => name.replace(/^(\d+)-(\w+)\.ts$/, '$2$1'))
    .sort();

  const config = (values: Record<string, unknown> = {}): ConfigService =>
    ({
      get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    }) as unknown as ConfigService;

  /** Boot the file the way the app does (the current default configuration). */
  const boot = async (): Promise<DataSource> => {
    const ds = new DataSource(mainConnectionOptions(config({ 'database.database': file })));
    return ds.initialize();
  };

  /** A main.sqlite as an earlier release left it: built by synchronize, with a scoped key and an audit row. */
  const seedSynchronizeBuilt = async (withAllowedChats: boolean): Promise<void> => {
    const ds = await new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: [ApiKey, AuditLog],
      synchronize: true,
    }).initialize();
    await ds.query(
      `INSERT INTO api_keys (id, name, keyHash, keyPrefix, allowedSessions, allowedChats) ` +
        `VALUES ('k1', 'scoped', 'h1', 'owa_k1', 's1', '123@g.us')`,
    );
    await ds.query(`INSERT INTO audit_logs (id, action) VALUES ('a1', 'api_key_created')`);
    if (!withAllowedChats) await ds.query(`ALTER TABLE api_keys DROP COLUMN allowedChats`);
    await ds.destroy();
  };

  const ledger = async (ds: DataSource): Promise<string[]> =>
    (await ds.query<Array<{ name: string }>>(`SELECT name FROM migrations`)).map(r => r.name).sort();

  /** Indexed columns per table, one entry per index: a duplicate index shows up as a repeated entry. */
  const indexedColumns = async (ds: DataSource, table: string): Promise<string[]> => {
    const indexes = await ds.query<Array<{ name: string; origin: string }>>(`PRAGMA index_list("${table}")`);
    const columns: string[] = [];
    for (const index of indexes.filter(i => i.origin === 'c')) {
      const info = await ds.query<Array<{ name: string }>>(`PRAGMA index_info("${index.name}")`);
      columns.push(info.map(c => c.name).join(','));
    }
    return columns.sort();
  };

  const expectOneIndexPerColumn = async (ds: DataSource): Promise<void> => {
    expect(await indexedColumns(ds, 'api_keys')).toEqual(['keyHash']);
    expect(await indexedColumns(ds, 'audit_logs')).toEqual(['action', 'apiKeyId', 'createdAt', 'sessionId']);
  };

  it('defaults to the migration chain on a fresh file', async () => {
    const ds = await boot();
    try {
      expect(ds.options.synchronize).toBe(false);
      expect(await ledger(ds)).toEqual(SHIPPED);
      await ds
        .getRepository(ApiKey)
        .save({ id: 'k1', name: 'n', keyHash: 'h', keyPrefix: 'p', allowedChats: ['1@g.us'] });
      expect((await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' })).allowedChats).toEqual(['1@g.us']);
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }
  });

  it('adopts a synchronize-built file from the previous release without losing a row or a scope', async () => {
    await seedSynchronizeBuilt(true);

    const ds = await boot();
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      const key = await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' });
      expect(key.allowedSessions).toEqual(['s1']);
      expect(key.allowedChats).toEqual(['123@g.us']);
      expect(await ds.getRepository(AuditLog).count()).toBe(1);
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }

    // A second boot has nothing left to run.
    const again = await boot();
    try {
      expect(await again.showMigrations()).toBe(false);
    } finally {
      await again.destroy();
    }
  });

  it('adds the chat-scope column to a file from a release that predates it', async () => {
    await seedSynchronizeBuilt(false);

    const ds = await boot();
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      const key = await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' });
      expect(key.allowedSessions).toEqual(['s1']);
      expect(key.allowedChats).toBeNull();
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }
  });

  it('still synchronizes, without migrations, when MAIN_DATABASE_SYNCHRONIZE=true', () => {
    const options = mainConnectionOptions(config({ 'database.synchronize': true }));
    expect(options.synchronize).toBe(true);
    expect(options.migrationsRun).toBe(false);
  });

  it('keeps the connection name Nest resolves the main DataSource by at shutdown', () => {
    expect(mainConnectionOptions(config()).name).toBe('main');
  });
});
