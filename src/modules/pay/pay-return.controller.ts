import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { paymentHandoffDestination } from './payment-handoff';

/** Spayon returns the browser here. The token does not say which checkout it belongs to. */
@Public()
@ApiExcludeController()
@Controller('pay')
export class PayReturnController {
  @Get('r/:token')
  handoff(@Param('token') token: string, @Res() response: Response): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const location = paymentHandoffDestination(token, process.env);
    if (!location) {
      response.status(404).type('text/plain').send('Payment not found');
      return;
    }
    response.redirect(302, location);
  }
}
