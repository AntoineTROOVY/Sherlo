import { resolveBetterAuthBaseURL } from '../account/account-actor';

const PRODUCT_HOSTS = new Set(['api.sherlo.co', 'app.sherlo.co']);

/** Public origin of the API that will serve the test card page. */
export function requestCheckoutOrigin(
  request: { protocol?: string; get?(name: string): string | undefined; headers?: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const host = firstHeader(request.headers?.['x-forwarded-host']) || request.get?.('host') || '';
  const proto = firstHeader(request.headers?.['x-forwarded-proto']) || request.protocol || 'https';
  return acceptedOrigin(`${proto}://${host}`, env) ?? acceptedOrigin(resolveBetterAuthBaseURL(env), env) ?? 'https://api.sherlo.co';
}

/** Returns the origin when it is a Sherlo host the card page can be served from. */
export function acceptedOrigin(value: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const trusted = loopback || PRODUCT_HOSTS.has(hostname) || configuredHosts(env).has(hostname);
  if (!trusted) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && loopback && env.NODE_ENV !== 'production') return url.origin;
  if (url.protocol === 'http:' && !loopback) return `https://${hostname}`;
  return null;
}

function configuredHosts(env: NodeJS.ProcessEnv): Set<string> {
  const hosts = new Set<string>();
  for (const value of [env.BETTER_AUTH_URL, env.BASE_URL, env.DASHBOARD_URL]) {
    if (!value?.trim()) continue;
    try {
      hosts.add(new URL(value).hostname.toLowerCase());
    } catch {
      // An unusable configured URL does not widen the allowlist.
    }
  }
  return hosts;
}

function firstHeader(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw.split(',')[0].trim() : '';
}
