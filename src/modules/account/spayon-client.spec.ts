import { createHmac } from 'node:crypto';
import { SpayonClient, verifySpayonSignature } from './spayon-client';

const credentials = { clientId: 'test-client', clientSecret: 'test-secret', environment: 'sandbox' as const };
const input = {
  product_name: 'Pro',
  price: 29,
  currency: 'EUR',
  order_id: 'order-1',
  callback_url: 'https://sherlo.example/callback',
  return_url: 'https://sherlo.example/billing',
  cancel_url: 'https://sherlo.example/billing',
  email: 'user@example.com',
  defaultPaymentMethod: 'visamaster' as const,
};

describe('Spayon API client', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });
  const reply = (body: unknown) => Response.json(body);

  it('uses sandbox routes, sends currency units and reuses the bearer token', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ session_id: 'session-1', session_url: 'https://spayon.io/session/session-1' }))
      .mockResolvedValueOnce(
        reply({ sessionId: 'session-1', orderId: 'order-1', status: 'paid', price: '29.00', currency: 'EUR' }),
      );
    const client = new SpayonClient(credentials);
    await expect(client.createSession(input)).resolves.toEqual({
      sessionId: 'session-1',
      url: 'https://spayon.io/session/session-1',
    });
    await expect(client.sessionStatus('session-1')).resolves.toMatchObject({ status: 'paid' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.spayon.io/api/sandbox/vendor/tokens');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.spayon.io/api/sandbox/vendor/checkout-session');
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual(input);
    expect((fetchMock.mock.calls[2][1]?.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('shares token generation between concurrent requests', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockImplementation(() =>
        Promise.resolve(reply({ sessionId: 's', orderId: 'o', status: 'pending', price: 29, currency: 'EUR' })),
      );
    const client = new SpayonClient(credentials);
    await Promise.all([client.sessionStatus('s'), client.sessionStatus('s')]);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/tokens'),
      ),
    ).toHaveLength(1);
  });

  it('rejects a mismatched payment session', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(
        reply({ sessionId: 'other', orderId: 'order-1', status: 'paid', price: 29, currency: 'EUR' }),
      );
    await expect(new SpayonClient(credentials).sessionStatus('session-1')).rejects.toThrow(
      'Invalid Spayon session status',
    );
  });

  it('does not leak provider error bodies', async () => {
    fetchMock.mockResolvedValue(Response.json({ secret: 'sensitive' }, { status: 401 }));
    await expect(new SpayonClient(credentials).createSession(input)).rejects.toThrow('Spayon API request failed (401)');
  });

  it('accepts the Safon checkout host returned for Telr sessions', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ session_id: 'session-1', session_url: 'https://pay.safon.io/session/session-1' }));
    await expect(new SpayonClient({ ...credentials, environment: 'production' }).createSession(input)).resolves.toEqual(
      { sessionId: 'session-1', url: 'https://pay.safon.io/session/session-1' },
    );
  });

  it('rejects a lookalike of the Safon checkout host', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(
        reply({ session_id: 'session-1', session_url: 'https://pay.safon.io.evil.example/session/session-1' }),
      );
    await expect(new SpayonClient(credentials).createSession(input)).rejects.toThrow('Invalid Spayon checkout URL');
  });

  it('accepts the production checkout host returned by the real Spayon API', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(
        reply({ session_id: 'session-1', session_url: 'https://pay.scoupon.am/session/session-1' }),
      );
    await expect(new SpayonClient({ ...credentials, environment: 'production' }).createSession(input)).resolves.toEqual(
      { sessionId: 'session-1', url: 'https://pay.scoupon.am/session/session-1' },
    );
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.spayon.io/api/tokens');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.spayon.io/api/product/session');
  });

  it('rejects lookalikes of the production checkout host', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(
        reply({ session_id: 'session-1', session_url: 'https://pay.scoupon.am.evil.example/session/session-1' }),
      );
    await expect(new SpayonClient(credentials).createSession(input)).rejects.toThrow('Invalid Spayon checkout URL');
  });

  it('rejects an external checkout URL', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ session_id: 's', session_url: 'https://spayon.io.evil.example/session' }));
    await expect(new SpayonClient(credentials).createSession(input)).rejects.toThrow('Invalid Spayon checkout URL');
  });
});

describe('Spayon callback signatures', () => {
  it('authenticates the exact original body bytes', () => {
    const raw = '{ "status": "paid" }';
    const signature = createHmac('sha256', 'secret').update(raw).digest('hex');
    expect(verifySpayonSignature(Buffer.from(raw), signature, 'secret')).toBe(true);
    expect(verifySpayonSignature('{"status":"paid"}', signature, 'secret')).toBe(false);
    expect(verifySpayonSignature(raw, signature, 'wrong-secret')).toBe(false);
  });
  it('rejects missing and malformed signatures without throwing', () => {
    for (const signature of [null, '', 'invalid', 'a'.repeat(63), 'z'.repeat(64)]) {
      expect(verifySpayonSignature('{}', signature, 'secret')).toBe(false);
    }
  });
});
