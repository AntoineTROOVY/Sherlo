import { join } from 'path';
import type { ConfigService } from '@nestjs/config';
import type { DataSourceOptions } from 'typeorm';

/**
 * TypeORM options for the main (auth/audit) connection, which is always a node-local SQLite file.
 *
 * Schema management defaults to the main-owned migration chain (migrations-main), like the data
 * connection. The chain is idempotent, so a file an earlier release built with synchronize is
 * adopted in place on the first boot: existing tables are kept, missing columns are added, and the
 * migrations ledger is written. MAIN_DATABASE_SYNCHRONIZE=true opts back into synchronize, which
 * then runs instead of the migrations.
 */
export function mainConnectionOptions(configService: ConfigService): DataSourceOptions & { name: string } {
  const synchronize = configService.get<boolean>('database.synchronize', false);
  return {
    // Nest's TypeOrmCoreModule resolves the DataSource to close at shutdown from these options.
    name: 'main',
    type: 'better-sqlite3',
    database: configService.get<string>('database.database', './data/main.sqlite'),
    entities: [
      join(__dirname, '..', 'modules/auth/**/*.entity{.ts,.js}'),
      join(__dirname, '..', 'modules/audit/**/*.entity{.ts,.js}'),
    ],
    // Dedicated migrations dir for the main connection only (must NOT run the data-connection
    // migrations, which target session/webhook/message tables).
    migrations: [join(__dirname, 'migrations-main/*{.ts,.js}')],
    synchronize,
    migrationsRun: !synchronize,
    logging: configService.get<boolean>('database.logging', false),
  };
}
