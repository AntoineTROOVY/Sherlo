import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from '../session/entities/session.entity';
import { AccountAuthService } from './account-auth.service';
import { accountAuthMiddleware } from './auth';

/**
 * Email accounts (Better Auth + SQLite) at /api/account.
 * The handler is mounted as Express middleware so it sees the raw body, ahead of the JSON parser
 * configureApp installs for the rest of the API. OpenWA's API-key guard stays the gate everywhere
 * else and accepts either a key or this account's cookie.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Session], 'data')],
  providers: [AccountAuthService],
  exports: [AccountAuthService],
})
export class AccountModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(accountAuthMiddleware).forRoutes('{*splat}');
  }
}
