import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, Matches, MaxLength, ValidateIf } from 'class-validator';

const NAME_MAX_LENGTH = 100;
const BODY_MAX_LENGTH = 4096;
const HEADER_FOOTER_MAX_LENGTH = 1024;

// name is a varchar(100) column, and PostgreSQL counts code points. @MaxLength does not: it folds a
// presentation selector (U+FE0F) into the character before it, so 100 emoji of two code points each
// passed and the INSERT failed as a 500. The u flag makes each matched unit one code point.
const NAME_PATTERN = new RegExp(`^[\\s\\S]{0,${NAME_MAX_LENGTH}}$`, 'u');
const NAME_LENGTH_MESSAGE = `name must be shorter than or equal to ${NAME_MAX_LENGTH} characters`;

export class CreateTemplateDto {
  @ApiProperty({
    description: 'Unique template name within the session',
    example: 'order-confirmation',
    maxLength: NAME_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @Matches(NAME_PATTERN, { message: NAME_LENGTH_MESSAGE })
  name!: string;

  @ApiProperty({
    description: 'Template body with {{variable}} placeholders',
    example: 'Hi {{customer}}, your order {{orderId}} has shipped.',
    maxLength: BODY_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX_LENGTH)
  body!: string;

  @ApiPropertyOptional({
    description: 'Optional header text, prepended to the rendered body',
    example: 'OpenWA Store',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  header?: string;

  @ApiPropertyOptional({
    description: 'Optional footer text, appended to the rendered body',
    example: 'Reply STOP to unsubscribe.',
    maxLength: HEADER_FOOTER_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  footer?: string;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional({ description: 'Template name', maxLength: NAME_MAX_LENGTH })
  // Not @IsOptional: that also skips null, which then reaches the NOT NULL column as a 500.
  @ValidateIf((o: UpdateTemplateDto) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  @Matches(NAME_PATTERN, { message: NAME_LENGTH_MESSAGE })
  name?: string;

  @ApiPropertyOptional({ description: 'Template body with {{variable}} placeholders', maxLength: BODY_MAX_LENGTH })
  @ValidateIf((o: UpdateTemplateDto) => o.body !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX_LENGTH)
  body?: string;

  @ApiPropertyOptional({ description: 'Optional header text', maxLength: HEADER_FOOTER_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  header?: string;

  @ApiPropertyOptional({ description: 'Optional footer text', maxLength: HEADER_FOOTER_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(HEADER_FOOTER_MAX_LENGTH)
  footer?: string;
}

export class TemplateResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  body!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  header?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  footer?: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
