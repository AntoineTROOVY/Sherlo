import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreatePayCheckoutDto {
  @ApiProperty({ example: 4, description: 'Price in currency units. 4 means 4.00, not 4 cents.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100000)
  amount!: number;

  @ApiPropertyOptional({ example: 'EUR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiProperty({ example: 'Pro plan' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  productName!: string;

  @ApiProperty({ example: 'buyer@example.com' })
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @ApiProperty({
    example: 'order-1001',
    description: 'Your own order reference. Repeating it returns the same payment.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  reference!: string;

  @ApiProperty({ description: 'Public page of your application. The buyer returns here, never to Sherlo.' })
  @IsString()
  @MaxLength(2000)
  returnUrl!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  cancelUrl!: string;
}

export class PayCheckoutResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'order-1001' })
  reference!: string;

  @ApiProperty({ enum: ['pending', 'paid', 'failed', 'expired'] })
  status!: 'pending' | 'paid' | 'failed' | 'expired';

  @ApiProperty({ example: 4, description: 'Price in currency units. 4 means 4.00, not 4 cents.' })
  amount!: number;

  @ApiProperty({ example: 'EUR' })
  currency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1684.2,
    description: 'Amount in AMD the buyer pays, as shown by the provider. Null until the bank page has been opened.',
  })
  amountAmd!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 421.05,
    description: 'AMD for 1 unit of currency, as shown by the provider. 421.05 means 1 EUR = 421.05 AMD.',
  })
  exchangeRate!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Bank page. Present while the payment can still be completed.',
  })
  url!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  paidAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  expiredAt!: string | null;
}
