import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks a key as `general` (WhatsApp and the rest of the API) or `payment`.
 * Existing rows stay general. Payment keys are listed only for the payment owner.
 */
export class AddApiKeyPurpose1791000000000 implements MigrationInterface {
  name = 'AddApiKeyPurpose1791000000000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    return rows.some(row => row.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'purpose'))) {
      await queryRunner.query(
        `ALTER TABLE "api_keys" ADD COLUMN "purpose" varchar(20) NOT NULL DEFAULT 'general'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'purpose')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "purpose"`);
    }
  }
}
