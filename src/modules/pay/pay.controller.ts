import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyPurpose, ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { CreatePayCheckoutDto, PayCheckoutResponseDto } from './pay.dto';
import { requestCheckoutOrigin } from './pay-origin';
import { PayService, type PayCheckoutResult } from './pay.service';

@ApiTags('pay')
@ApiSecurity('api-key')
@Controller('pay/checkouts')
@RequireUnscopedKey()
@RequireRole(ApiKeyRole.OPERATOR)
export class PayController {
  constructor(private readonly pay: PayService) {}

  @Post()
  @ApiCreatedResponse({ type: PayCheckoutResponseDto })
  @ApiOperation({
    summary: 'Open a bank payment',
    description:
      'Creates a payment on https://api.sherlo.co. The response url is the bank page. The caller reads the result with GET /api/pay/checkouts/{id}. status paid is the confirmation.',
  })
  create(
    @Req() request: Request,
    @Body() body: CreatePayCheckoutDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<PayCheckoutResult> {
    this.assertApiKey(request);
    return this.pay.create(body, {
      test: apiKey?.purpose === ApiKeyPurpose.PAYMENT_TEST,
      origin: requestCheckoutOrigin(request),
    });
  }

  @Get(':id')
  @ApiOkResponse({ type: PayCheckoutResponseDto })
  @ApiOperation({ summary: 'Read a payment result' })
  find(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): PayCheckoutResult {
    this.assertApiKey(request);
    return this.pay.find(id, apiKey?.purpose === ApiKeyPurpose.PAYMENT_TEST);
  }

  /** A dashboard cookie must not open payments. Only an API key from another application can. */
  private assertApiKey(request: Request): void {
    const header = request.headers['x-api-key'] ?? request.headers.authorization;
    if (typeof header !== 'string' || !header.trim()) {
      throw new UnauthorizedException('An API key is required');
    }
  }
}
