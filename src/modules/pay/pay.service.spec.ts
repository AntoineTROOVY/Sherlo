import { BadRequestException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minorUnits, PayService } from './pay.service';

const previous = {
  AUTH_DATABASE_PATH: process.env.AUTH_DATABASE_PATH,
  SPAYON_CLIENT_ID: process.env.SPAYON_CLIENT_ID,
  SPAYON_CLIENT_SECRET: process.env.SPAYON_CLIENT_SECRET,
  SPAYON_ENVIRONMENT: process.env.SPAYON_ENVIRONMENT,
  SPAYON_CURRENCY: process.env.SPAYON_CURRENCY,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('keeps currency units exact down to cents', () => {
  expect(minorUnits(4)).toBe(400);
  expect(minorUnits(4.5)).toBe(450);
  expect(() => minorUnits(4.001)).toThrow(BadRequestException);
  expect(() => minorUnits(0)).toThrow(BadRequestException);
});

it('refuses a customer return URL that is not public HTTPS before contacting the provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sherlo-pay-service-'));
  process.env.AUTH_DATABASE_PATH = join(directory, 'auth.sqlite');
  process.env.SPAYON_CLIENT_ID = 'client';
  process.env.SPAYON_CLIENT_SECRET = 'secret';
  process.env.SPAYON_ENVIRONMENT = 'production';
  process.env.SPAYON_CURRENCY = 'EUR';
  process.env.BETTER_AUTH_URL = 'https://api.sherlo.example';
  const service = new PayService();
  const input = {
    amount: 4,
    productName: 'Other app',
    email: 'buyer@example.com',
    reference: 'order-1',
    returnUrl: 'http://localhost:3000/thanks',
    cancelUrl: 'https://app.example/cancel',
  };
  await expect(service.create(input)).rejects.toThrow(BadRequestException);
  await expect(service.create({ ...input, returnUrl: 'https://10.0.0.1/thanks' })).rejects.toThrow(BadRequestException);
  rmSync(directory, { recursive: true, force: true });
});
