import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDefaultConfig } from '../config/index.js';
import { WebServer } from '../server/web-server.js';
import { HostGuard, parseHostList } from '../utils/host-guard.js';

describe('HostGuard (unit)', () => {
  const guard = (extraHosts: string[] = [], port = 5000) =>
    new HostGuard({ getPort: () => port, extraHosts });

  test('allows loopback hosts on the listening port', () => {
    const g = guard();
    expect(g.check('localhost:5000', undefined).allowed).toBe(true);
    expect(g.check('127.0.0.1:5000', undefined).allowed).toBe(true);
    expect(g.check('[::1]:5000', undefined).allowed).toBe(true);
    expect(g.check('LOCALHOST:5000', undefined).allowed).toBe(true);
  });

  test('rejects loopback hosts on a different port', () => {
    const g = guard();
    expect(g.check('localhost:5001', undefined).allowed).toBe(false);
    expect(g.check('127.0.0.1', undefined).allowed).toBe(false);
  });

  test('rejects foreign and look-alike hosts (DNS rebinding)', () => {
    const g = guard();
    expect(g.check('evil.example.com:5000', undefined).allowed).toBe(false);
    expect(g.check('localhost.evil.example.com:5000', undefined).allowed).toBe(false);
    expect(g.check('localhost:5000@evil.example.com', undefined).allowed).toBe(false);
    expect(g.check('127.0.0.1:5000/path', undefined).allowed).toBe(false);
    expect(g.check('localhost.:5000', undefined).allowed).toBe(false);
  });

  test('rejects a missing Host header', () => {
    expect(guard().check(undefined, undefined).allowed).toBe(false);
    expect(guard().check('', undefined).allowed).toBe(false);
  });

  test('allows requests without an Origin header (curl, MCP clients)', () => {
    expect(guard().check('localhost:5000', undefined).allowed).toBe(true);
    expect(guard().check('localhost:5000', '').allowed).toBe(true);
  });

  test('allows same-origin requests', () => {
    const g = guard();
    expect(g.check('localhost:5000', 'http://localhost:5000').allowed).toBe(true);
    expect(g.check('127.0.0.1:5000', 'http://127.0.0.1:5000').allowed).toBe(true);
  });

  test('rejects cross-site origins', () => {
    const g = guard();
    expect(g.check('localhost:5000', 'https://evil.example.com').allowed).toBe(false);
    expect(g.check('localhost:5000', 'http://localhost:3000').allowed).toBe(false);
    expect(g.check('localhost:5000', 'null').allowed).toBe(false);
    expect(g.check('localhost:5000', 'file://').allowed).toBe(false);
    expect(g.check('localhost:5000', 'not a url').allowed).toBe(false);
  });

  test('extra host without port matches any port', () => {
    const g = guard(['feedback.example.com']);
    expect(g.check('feedback.example.com', 'https://feedback.example.com').allowed).toBe(true);
    expect(g.check('feedback.example.com:8443', 'https://feedback.example.com:8443').allowed).toBe(true);
    expect(g.check('other.example.com', undefined).allowed).toBe(false);
  });

  test('extra host with port matches only that port', () => {
    const g = guard(['tunnel.local:9000']);
    expect(g.check('tunnel.local:9000', undefined).allowed).toBe(true);
    expect(g.check('tunnel.local:9001', undefined).allowed).toBe(false);
  });

  test('extra host may be a full URL', () => {
    const g = guard(['https://feedback.example.com/some/path']);
    expect(g.check('feedback.example.com', 'https://feedback.example.com').allowed).toBe(true);
  });

  test('a loopback name in extra hosts opens every port (SSH tunnels)', () => {
    const g = guard(['localhost']);
    expect(g.check('localhost:9000', 'http://localhost:9000').allowed).toBe(true);
  });

  test('"*" disables the check', () => {
    const g = guard(['*']);
    expect(g.isDisabled()).toBe(true);
    expect(g.check('evil.example.com', 'https://evil.example.com').allowed).toBe(true);
    expect(g.check(undefined, undefined).allowed).toBe(true);
  });

  test('reads the port lazily', () => {
    let port = 0;
    const g = new HostGuard({ getPort: () => port });
    expect(g.check('localhost:4321', undefined).allowed).toBe(false);
    port = 4321;
    expect(g.check('localhost:4321', undefined).allowed).toBe(true);
  });

  test('the bind address is port-strict like loopback', () => {
    const g = new HostGuard({
      getPort: () => 5000,
      localHosts: ['192.168.1.5', '::1', '0.0.0.0', undefined]
    });
    expect(g.check('192.168.1.5:5000', 'http://192.168.1.5:5000').allowed).toBe(true);
    expect(g.check('192.168.1.5:5001', undefined).allowed).toBe(false);
    expect(g.check('192.168.1.5:5000', 'http://192.168.1.5:3000').allowed).toBe(false);
    expect(g.check('[::1]:5000', undefined).allowed).toBe(true);
    // A wildcard bind address is never trusted as a host name.
    expect(g.check('0.0.0.0:5000', undefined).allowed).toBe(false);
  });

  test('describe() lists the allow-list', () => {
    expect(guard(['a.example.com']).describe()).toContain('localhost:5000');
    expect(guard(['a.example.com']).describe()).toContain('a.example.com');
    expect(guard(['*']).describe()).toContain('disabled');
  });

  test('parseHostList splits on commas and whitespace', () => {
    expect(parseHostList('a.com, b.com:81  c.com')).toEqual(['a.com', 'b.com:81', 'c.com']);
    expect(parseHostList('')).toEqual([]);
    expect(parseHostList(undefined)).toEqual([]);
  });
});

interface HttpResult {
  status: number;
  body: string;
}

function send(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  payload?: string
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('WebServer Host/Origin guard (integration)', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let webServer: WebServer;
  let port: number;

  // One server for the whole block: stopping a server waits for the port to be
  // released, which makes per-test start/stop slow.
  beforeAll(async () => {
    // Keep the pending-instruction queue away from the real home directory.
    previousDataDir = process.env['MCP_FEEDBACK_DATA_DIR'];
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfc-guard-'));
    process.env['MCP_FEEDBACK_DATA_DIR'] = dataDir;

    const config = createDefaultConfig();
    config.webPort = 0;
    config.logLevel = 'error';
    webServer = new WebServer(config);
    await webServer.start();
    port = webServer.getPort();
  });

  afterAll(async () => {
    await webServer.stop();
    if (previousDataDir === undefined) {
      delete process.env['MCP_FEEDBACK_DATA_DIR'];
    } else {
      process.env['MCP_FEEDBACK_DATA_DIR'] = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('listens on loopback only by default', () => {
    const address = (webServer as any).server.address();
    expect(address.address).toBe('127.0.0.1');
  });

  test('serves normal local requests', async () => {
    const byIp = await send(port, 'GET', '/health');
    expect(byIp.status).toBe(200);

    const byName = await send(port, 'GET', '/health', { Host: `localhost:${port}` });
    expect(byName.status).toBe(200);

    const sameOrigin = await send(port, 'GET', '/health', { Origin: `http://localhost:${port}` });
    expect(sameOrigin.status).toBe(200);
  });

  test('blocks DNS-rebinding style Host headers', async () => {
    const result = await send(port, 'GET', '/health', { Host: `evil.example.com:${port}` });
    expect(result.status).toBe(403);
  });

  test('blocks cross-site reads', async () => {
    const result = await send(port, 'GET', '/api/pending-instructions', {
      Origin: 'https://evil.example.com'
    });
    expect(result.status).toBe(403);
  });

  test('blocks cross-site instruction injection and leaves the queue empty', async () => {
    const body = JSON.stringify({ content: 'rm -rf /' });
    const blocked = await send(
      port,
      'POST',
      '/api/pending-instructions',
      {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        Origin: 'https://evil.example.com'
      },
      body
    );
    expect(blocked.status).toBe(403);

    const list = await send(port, 'GET', '/api/pending-instructions');
    expect(list.status).toBe(200);
    expect(JSON.stringify(JSON.parse(list.body))).not.toContain('rm -rf');
  });

  test('same-origin instruction queueing still works', async () => {
    const body = JSON.stringify({ content: 'please add tests' });
    const created = await send(
      port,
      'POST',
      '/api/pending-instructions',
      {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        Origin: `http://localhost:${port}`,
        Host: `localhost:${port}`
      },
      body
    );
    expect(created.status).toBeLessThan(300);

    const list = await send(port, 'GET', '/api/pending-instructions');
    expect(list.body).toContain('please add tests');
  });

  test('blocks the Socket.IO handshake from a foreign origin', async () => {
    const result = await send(port, 'GET', '/socket.io/?EIO=4&transport=polling', {
      Origin: 'https://evil.example.com'
    });
    expect(result.status).toBe(403);
  });

  test('allows the Socket.IO handshake from the page itself', async () => {
    const result = await send(port, 'GET', '/socket.io/?EIO=4&transport=polling', {
      Origin: `http://localhost:${port}`,
      Host: `localhost:${port}`
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain('"sid"');
  });
});

describe('WebServer Host/Origin guard (configuration)', () => {
  const start = async (mutate: (config: ReturnType<typeof createDefaultConfig>) => void) => {
    const config = createDefaultConfig();
    config.webPort = 0;
    config.logLevel = 'error';
    mutate(config);
    const server = new WebServer(config);
    await server.start();
    return server;
  };

  test('MCP_ALLOWED_HOSTS entries are honoured', async () => {
    const server = await start(config => {
      config.allowedHosts = ['feedback.example.com'];
    });
    try {
      const allowed = await send(server.getPort(), 'GET', '/health', { Host: 'feedback.example.com' });
      expect(allowed.status).toBe(200);
      const blocked = await send(server.getPort(), 'GET', '/health', { Host: 'other.example.com' });
      expect(blocked.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  test('"*" disables the guard', async () => {
    const server = await start(config => {
      config.allowedHosts = ['*'];
    });
    try {
      const result = await send(server.getPort(), 'GET', '/health', {
        Host: 'anything.example.com',
        Origin: 'https://anything.example.com'
      });
      expect(result.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test('MCP_SERVER_HOST changes the bind address and stays port-strict', async () => {
    const server = await start(config => {
      config.serverHost = '127.0.0.1';
    });
    try {
      const address = (server as any).server.address();
      expect(address.address).toBe('127.0.0.1');

      const port = server.getPort();
      const sameOrigin = await send(port, 'GET', '/health', { Origin: `http://127.0.0.1:${port}` });
      expect(sameOrigin.status).toBe(200);
      // Another local web app on a different port must not be trusted.
      const otherLocalApp = await send(port, 'GET', '/health', { Origin: 'http://127.0.0.1:1' });
      expect(otherLocalApp.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});
