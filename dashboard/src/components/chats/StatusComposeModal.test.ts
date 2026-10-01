// An image status is posted as base64 JSON, so a file past the upload cap is refused only after the whole
// inflated body went up. The picker rejects it before reading, like the chat composer does.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let render: () => ReturnType<typeof import('@testing-library/react').render>;
let queryClient: import('@tanstack/react-query').QueryClient;

let reads = 0;
// Reads count, then finish on the next microtask with a data URL carrying the file's type.
class CountingFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null;
  readAsDataURL(file: Blob): void {
    reads += 1;
    queueMicrotask(() => this.onload?.({ target: { result: `data:${file.type};base64,eA==` } }));
  }
}

// Bodies the modal posted, in order.
const posted: unknown[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).FileReader = CountingFileReader;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'status-1' }), { headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  const { default: StatusComposeModal } = await import('./StatusComposeModal.tsx');
  queryClient = new QueryClient();
  const role = {
    role: 'operator' as const,
    setRole: () => undefined,
    isAdmin: false,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'whatsapp-web.js',
    setEngineType: () => undefined,
  };
  render = () =>
    rtl.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          RoleContext.Provider,
          { value: role },
          createElement(
            ToastProvider,
            null,
            createElement(StatusComposeModal, { sessionId: 's1', onClose: () => undefined, onPosted: () => undefined }),
          ),
        ),
      ),
    );
});

afterEach(() => {
  rtl.cleanup();
  reads = 0;
  posted.length = 0;
});

after(() => {
  rtl.cleanup();
  // Drops the unmounted query's five-minute garbage-collection timer, which would hold the runner open.
  queryClient.clear();
});

test('an image past the upload cap is refused before it is read', async () => {
  const { screen, fireEvent } = rtl;
  render();
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  const file = new window.File(['x'], 'huge.jpg', { type: 'image/jpeg' });
  Object.defineProperty(file, 'size', { value: 18 * 1024 * 1024 + 1 });
  fireEvent.change(screen.getByLabelText('Status image'), { target: { files: [file] } });

  await screen.findByText('File is too large (max 18 MB)');
  assert.equal(reads, 0, 'the oversized file was read');
});

test('an oversized pick also drops the earlier pick it was meant to replace', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  render();
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  const input = screen.getByLabelText('Status image');
  fireEvent.change(input, { target: { files: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
  const post = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(post.disabled, false));

  const huge = new window.File(['x'], 'huge.jpg', { type: 'image/jpeg' });
  Object.defineProperty(huge, 'size', { value: 18 * 1024 * 1024 + 1 });
  fireEvent.change(input, { target: { files: [huge] } });
  await screen.findByText('File is too large (max 18 MB)');
  // The input now reads "No file chosen", so nothing on screen shows the earlier image any more.
  assert.equal(post.disabled, true, 'the hidden earlier pick can still be posted');
});
