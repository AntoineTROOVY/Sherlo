import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { PayService, type TestPageResult } from './pay.service';
import { testMissingPage } from './pay-test-page';

@Public()
@ApiExcludeController()
@Controller('pay/test')
export class PayTestController {
  constructor(private readonly pay: PayService) {}

  @Get(':id/cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('t') token: string | string[] | undefined,
    @Res() response: Response,
  ): void {
    this.send(response, this.pay.cancelTestCheckout(id, one(token)));
  }

  @Get(':id')
  show(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('t') token: string | string[] | undefined,
    @Res() response: Response,
  ): void {
    this.send(response, this.pay.testCheckout(id, one(token)));
  }

  @Post(':id')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('t') token: string | string[] | undefined,
    @Res() response: Response,
  ): void {
    this.send(response, this.pay.completeTestCheckout(id, one(token)));
  }

  private send(response: Response, result: TestPageResult | null): void {
    response.setHeader('Cache-Control', 'no-store');
    if (!result) {
      response.status(404).type('html').send(testMissingPage());
      return;
    }
    if (result.action === 'redirect') {
      response.redirect(303, result.location);
      return;
    }
    response.status(result.status).type('html').send(result.html);
  }
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
