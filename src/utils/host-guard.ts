/**
 * Host / Origin guard for the local web UI.
 *
 * The feedback page has no login, yet it can speak for the user: it submits
 * feedback and queues instructions that the agent will act on. Two browser
 * based attacks can reach a loopback-only server, so both are blocked here:
 *
 *   1. Cross-site requests. Any web page you visit can fire requests at
 *      http://127.0.0.1:<port>. Browsers attach an Origin header to every
 *      cross-origin request (and to every WebSocket handshake), so a foreign
 *      Origin is rejected.
 *   2. DNS rebinding. An attacker's domain re-resolves to 127.0.0.1, which makes
 *      the request look same-origin to the browser. The Host header still
 *      carries the attacker's domain, so only known hosts are accepted.
 *
 * Non-browser clients (curl, MCP clients, health checks) send no Origin header
 * and a normal Host header, so they are unaffected.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface HostGuardOptions {
  /** Actual listening port. Read lazily: it is only known after listen(). */
  getPort: () => number;
  /**
   * Additional hostnames that are served on the listening port, such as the
   * configured bind address. Like loopback names they must match the port.
   */
  localHosts?: readonly (string | undefined)[];
  /**
   * Extra allowed hosts. Each entry is "host" (any port), "host:port", or a full
   * URL such as "https://feedback.example.com". A single "*" disables the check.
   */
  extraHosts?: readonly (string | undefined)[];
}

export interface GuardVerdict {
  allowed: boolean;
  reason?: string;
}

interface Authority {
  hostname: string;
  /** Empty string means "no explicit port" (for entries: any port). */
  port: string;
}

/** Parse "host[:port]" as found in a Host header. Returns null if malformed. */
function parseAuthority(value: string): Authority | null {
  try {
    const url = new URL(`http://${value.trim()}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return { hostname: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

/** Parse an Origin header ("scheme://host[:port]"). Returns null if malformed or "null". */
function parseOrigin(value: string): Authority | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return { hostname: url.hostname.toLowerCase(), port: url.port };
  } catch {
    return null;
  }
}

/** Parse a configured entry: either a full URL or "host[:port]". */
function parseEntry(value: string): Authority | null {
  return value.includes('://') ? parseOrigin(value) : parseAuthority(value);
}

/** Lower-case a bare hostname and bracket IPv6 literals, matching URL.hostname. */
function normalizeHostname(value: string): string {
  const host = value.trim().toLowerCase();
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Wildcard bind addresses are never a name a browser would send in Host. */
const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::', '[::]']);

export class HostGuard {
  private readonly entries: Authority[] = [];
  private readonly localHostnames: Set<string>;
  private readonly allowAny: boolean;

  constructor(private readonly options: HostGuardOptions) {
    const raw = (options.extraHosts ?? [])
      .map(entry => (entry ?? '').trim())
      .filter(entry => entry.length > 0);

    this.allowAny = raw.includes('*');
    for (const entry of raw) {
      if (entry === '*') continue;
      const parsed = parseEntry(entry);
      if (parsed) this.entries.push(parsed);
    }

    this.localHostnames = new Set(LOOPBACK_HOSTNAMES);
    for (const host of options.localHosts ?? []) {
      if (!host || !host.trim()) continue;
      const normalized = normalizeHostname(host);
      if (!WILDCARD_ADDRESSES.has(normalized)) this.localHostnames.add(normalized);
    }
  }

  /** True when the check is disabled via MCP_ALLOWED_HOSTS=*. */
  isDisabled(): boolean {
    return this.allowAny;
  }

  /** Human readable allow-list, for the startup log. */
  describe(): string {
    if (this.allowAny) return '* (check disabled)';
    const port = this.options.getPort();
    const local = [...this.localHostnames].map(host => `${host}:${port}`);
    const extra = this.entries.map(e => (e.port ? `${e.hostname}:${e.port}` : e.hostname));
    return [...local, ...extra].join(', ');
  }

  /**
   * Decide whether a request may proceed.
   * @param host   value of the Host header
   * @param origin value of the Origin header, if the client sent one
   */
  check(host: string | undefined, origin: string | undefined): GuardVerdict {
    if (this.allowAny) return { allowed: true };

    if (!host) {
      return { allowed: false, reason: 'missing Host header' };
    }
    const hostAuthority = parseAuthority(host);
    if (!hostAuthority || !this.matches(hostAuthority)) {
      return { allowed: false, reason: `Host not allowed: ${host}` };
    }

    if (origin !== undefined && origin !== '') {
      const originAuthority = parseOrigin(origin);
      if (!originAuthority || !this.matches(originAuthority)) {
        return { allowed: false, reason: `Origin not allowed: ${origin}` };
      }
    }

    return { allowed: true };
  }

  private matches(candidate: Authority): boolean {
    if (this.localHostnames.has(candidate.hostname) && candidate.port === String(this.options.getPort())) {
      return true;
    }
    return this.entries.some(
      entry => entry.hostname === candidate.hostname && (entry.port === '' || entry.port === candidate.port)
    );
  }
}

/** Split a comma/space separated env value such as MCP_ALLOWED_HOSTS. */
export function parseHostList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}
