import { NotContains } from 'class-validator';

/** PostgreSQL text and varchar columns cannot store U+0000, so the write would fail as a 500. */
export const NoNulCharacter = (): PropertyDecorator =>
  NotContains('\u0000', { message: '$property must not contain a NUL character' });
