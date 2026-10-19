import { Module } from '@nestjs/common';
import { PayController } from './pay.controller';
import { PayTestController } from './pay-test.controller';
import { PayService } from './pay.service';

@Module({
  controllers: [PayController, PayTestController],
  providers: [PayService],
})
export class PayModule {}
