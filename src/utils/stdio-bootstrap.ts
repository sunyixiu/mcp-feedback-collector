/**
 * stdio-bootstrap
 * ============================================================
 * 必须作为进程入口的【第一个 import】加载
 * ES module 下所有 import 的 top-level 代码都会在主文件代码之前执行，
 * 所以把 stdout 保护放进一个独立模块、让它变成第一个被 require 的依赖
 *
 * 作用：当 MCP_TRANSPORT_MODE=stdio 时，锁住 stdout
 *   - console.log / console.info / console.debug 都重绑到 stderr
 *   - 避免任何库启动期输出污染 MCP JSON-RPC 协议流
 *   - MCP stdio transport 独占 stdout，用来发 JSON-RPC 消息
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const isStdioMcp = process.env['MCP_TRANSPORT_MODE'] === 'stdio';

// 诊断日志文件 —— 写到 temp，拿进程 pid 区分
const __diagLogPath = path.join(os.tmpdir(), `mcp-stdio-diag-${process.pid}.log`);
function diagLog(...args: unknown[]) {
  try {
    const line =
      `[${new Date().toISOString()}] ` +
      args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') +
      '\n';
    fs.appendFileSync(__diagLogPath, line);
  } catch {
    /* ignore */
  }
}

if (isStdioMcp) {
  diagLog('=== stdio-bootstrap active, pid=' + process.pid + ' ===');
  diagLog('cwd=' + process.cwd());
  diagLog('argv=' + JSON.stringify(process.argv));
  diagLog('env MCP_*=' + JSON.stringify(
    Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('MCP_'))
    )
  ));

  const toStderr = (...args: unknown[]) => {
    process.stderr.write(
      args
        .map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ') + '\n'
    );
  };

  // 把 stdout 方向的 console 方法全部重绑到 stderr
  console.log = toStderr as typeof console.log;
  console.info = toStderr as typeof console.info;
  console.debug = toStderr as typeof console.debug;

  // 保险：直接拦截 process.stdout.write，只允许以 `{` 开头的 JSON-RPC 字符串通过
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    try {
      const str =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);

      const trimmed = str.trimStart();
      // 记录所有发往 stdout 的内容（最多 500 字符）
      diagLog('[stdout->]', trimmed.slice(0, 500));
      // 只有以 { 或 [ 开头的才是 MCP JSON-RPC，其他一律扔 stderr
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return origStdoutWrite(chunk, ...rest);
      } else {
        diagLog('[REDIRECTED to stderr]');
        return process.stderr.write(chunk, ...rest);
      }
    } catch {
      return origStdoutWrite(chunk, ...rest);
    }
  }) as typeof process.stdout.write;

  // 监听所有的进程事件
  process.on('exit', code => diagLog(`[process.exit] code=${code}`));
  process.on('uncaughtException', e => diagLog('[uncaughtException]', e.message, e.stack));
  process.on('unhandledRejection', (r: any) => diagLog('[unhandledRejection]', r?.message || String(r)));
  process.on('SIGTERM', () => diagLog('[SIGTERM]'));
  process.on('SIGINT', () => diagLog('[SIGINT]'));
  process.stdin.on('end', () => diagLog('[stdin END]'));
  process.stdin.on('close', () => diagLog('[stdin CLOSE]'));
  process.stdin.on('error', e => diagLog('[stdin ERROR]', e.message));
  process.stdout.on('error', e => diagLog('[stdout ERROR]', e.message));

  // 每 1 秒打一次活
  setInterval(() => diagLog('[alive] uptime=' + process.uptime().toFixed(2) + 's'), 1000).unref();
}

export const STDIO_BOOTSTRAP_ACTIVE = isStdioMcp;
export const STDIO_DIAG_LOG_PATH = __diagLogPath;
export { diagLog };
