import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Access control for the local HTTP servers (studio, render server).
 *
 * Without it, any web page the user visits can send requests to http://127.0.0.1:<port> (CSRF),
 * and DNS rebinding lets such a page read the answers too. The guard requires a random
 * per-server token on every request (header, query parameter or an HttpOnly SameSite=Strict
 * cookie set from the query parameter), refuses foreign `Host` headers (DNS rebinding) and
 * refuses requests a browser marks as coming from another origin.
 */
export interface RequestGuard {
  /** The secret every request must carry. */
  readonly token: string;
  /** Checks a request. Answers it (401 / 403) and returns false when it is refused. */
  check(req: IncomingMessage, res: ServerResponse): boolean;
  /** Checks a request without answering it (WebSocket upgrades). */
  allows(req: IncomingMessage): boolean;
  /** `base` with the token as a query parameter: the link to open in a browser. */
  link(base: string): string;
}

export interface RequestGuardOptions {
  /** Accept any Host header (the server is bound to a non-loopback address on purpose). */
  allowAnyHost?: boolean;
  /** Fixed token (tests); random by default. */
  token?: string;
}

export const TOKEN_HEADER = 'x-tasweerix-token';
export const TOKEN_PARAM = 'token';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for a host name that only ever resolves to this machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith('.localhost');
}

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sameSecret(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type Verdict = { ok: true; setCookie: boolean } | { ok: false; status: number; reason: string };

export function createRequestGuard(opts: RequestGuardOptions = {}): RequestGuard {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  // Cookies are not separated by port, so each server port gets its own cookie name.
  const cookieName = (req: IncomingMessage) => `tasweerix-${req.socket.localPort ?? 0}`;

  const verdict = (req: IncomingMessage): Verdict => {
    const host = req.headers.host;
    const hostname = hostnameOf(host);
    if (!hostname || (!opts.allowAnyHost && !isLoopbackHost(hostname))) return { ok: false, status: 403, reason: 'Forbidden host' };
    // Browsers send Origin on cross-origin requests and Sec-Fetch-Site on all of them; only the
    // server's own pages (or the user opening a link: "none") may call it.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return { ok: false, status: 403, reason: 'Forbidden origin' };
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return { ok: false, status: 403, reason: 'Forbidden origin' };
    const header = req.headers[TOKEN_HEADER];
    if (sameSecret(typeof header === 'string' ? header : undefined, token)) return { ok: true, setCookie: false };
    if (sameSecret(cookieValue(req, cookieName(req)), token)) return { ok: true, setCookie: false };
    const query = new URL(req.url ?? '/', 'http://x').searchParams.get(TOKEN_PARAM) ?? undefined;
    if (sameSecret(query, token)) return { ok: true, setCookie: true };
    return { ok: false, status: 401, reason: 'Missing or wrong access token: open the link printed when the server started' };
  };

  return {
    token,
    check(req, res) {
      const v = verdict(req);
      if (!v.ok) {
        res.writeHead(v.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(v.reason);
        return false;
      }
      if (v.setCookie) res.setHeader('set-cookie', `${cookieName(req)}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      return true;
    },
    allows: (req) => verdict(req).ok,
    link(base) {
      const u = new URL(base);
      u.searchParams.set(TOKEN_PARAM, token);
      return u.toString();
    },
  };
}
