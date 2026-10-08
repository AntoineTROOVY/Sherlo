// Login page under the bare `node --test` runner, on the jsdom harness the other page tests use.
// Email is trimmed before it is sent; a gateway that is down is not reported as bad credentials;
// and the form's alignment must follow the document direction set on <html>.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

let sentEmail: string | null = null;
let reply: () => Response = okReply;

function okReply(): Response {
  return new Response(JSON.stringify({ valid: true, role: 'admin' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchStub(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.body && typeof init.body === 'string') {
      sentEmail = (JSON.parse(init.body) as { email?: string }).email ?? null;
    }
    return Promise.resolve(reply());
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Login: (typeof import('./Login.tsx'))['Login'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-01-01T00:00:00.000Z';
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Login } = await import('./Login.tsx'));
});

afterEach(() => {
  sentEmail = null;
  reply = okReply;
  rtl.cleanup();
});

function fillCredentials(): void {
  const { screen, fireEvent } = rtl;
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  ada@example.com ' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
}

test('an email pasted with surrounding whitespace is sent trimmed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const logins: Array<string | undefined> = [];
  rtl.render(createElement(Login, { onLogin: role => logins.push(role) }));

  fillCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins, ['admin']);
  assert.equal(sentEmail, 'ada@example.com');
});

async function submitAndReadError(): Promise<string> {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('a refused account signed in') }));
  fillCredentials();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  const message = await rtl.waitFor(() => {
    const el = document.querySelector('.error-message');
    assert.ok(el);
    return el.textContent ?? '';
  });
  return message;
}

test('a proxy error page while the gateway is down is a connection error, not an invalid key', async () => {
  reply = () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a 5xx with a JSON message is still a connection error', async () => {
  reply = () => new Response(JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }), { status: 503 });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a refused sign-in keeps the reason the gateway gave', async () => {
  reply = () => new Response(JSON.stringify({ message: 'Invalid email or password' }), { status: 401 });
  assert.equal(await submitAndReadError(), 'Invalid email or password');
});

test('a 401 without a message reads as invalid credentials', async () => {
  reply = () => new Response('', { status: 401 });
  assert.equal(await submitAndReadError(), 'Invalid email or password');
});

test('a refusal other than 401 without a message is a connection error, not an invalid key', async () => {
  reply = () => new Response('', { status: 403 });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('the login form aligns to the document direction, which is set on <html>', () => {
  const css = readFileSync(fileURLToPath(new URL('./Login.css', import.meta.url)), 'utf8');
  // i18n sets `dir` on the document element only, so a `[dir]` compound after another selector part
  // would need a second element carrying `dir` inside the page and never matches.
  assert.deepEqual(css.match(/[^\s,{}][^,{}]*\s\[dir[^\]]*\][^{]*/g) ?? [], []);
  assert.match(css, /\.login-container \.login-form \{\s*text-align: start;\s*\}/);
});
