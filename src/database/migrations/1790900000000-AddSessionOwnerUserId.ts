import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stamps each WhatsApp session with the Better Auth user that created it.
 * NULL on every existing row: those stay visible to an instance admin, and a member account
 * never matches them. Hand-authored because synchronize is off on the data connection.
 */
export class AddSessionOwnerUserId1790900000000 implements MigrationInterface {
  name = 'AddSessionOwnerUserId1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('sessions', 'ownerUserId'))) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "ownerUserId" varchar(128)`);
    }
    const table = await queryRunner.getTable('sessions');
    if (!table?.indices.some(index => index.name === 'IDX_sessions_ownerUserId')) {
      await queryRunner.query(`CREATE INDEX "IDX_sessions_ownerUserId" ON "sessions" ("ownerUserId")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('sessions');
    if (table?.indices.some(index => index.name === 'IDX_sessions_ownerUserId')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_ownerUserId"`);
    }
    if (await queryRunner.hasColumn('sessions', 'ownerUserId')) {
      await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "ownerUserId"`);
    }
  }
}
