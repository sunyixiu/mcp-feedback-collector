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
 *
 * 诊断日志（默认关闭）：
 *   设置 MCP_STDIO_DIAG=true 后，进程事件和发往 stdout 的消息开头会被写到
 *   系统临时目录的 mcp-stdio-diag-<pid>.log，用于排查协议被污染 / 进程意外退出。
 *   日志可能包含反馈内容片段；名字像密钥的环境变量会被脱敏。
 *   排障结束后请关闭该开关，并手动删除这些日志文件。
 * ============================================================
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const isStdioMcp = process.env['MCP_TRANSPORT_MODE'] === 'stdio';
const diagEnabled = isStdioMcp && process.env['MCP_STDIO_DIAG'] === 'true';

// 诊断日志文件 —— 写到 temp，拿进程 pid 区分
const __diagLogPath = path.join(os.tmpdir(), `mcp-stdio-diag-${process.pid}.log`);
function diagLog(...args: unknown[]) {
  if (!diagEnabled) {
    return;
  }
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

// 名字像密钥的环境变量一律脱敏，避免诊断日志泄露 API Key
const SECRET_NAME_PATTERN = /(key|token|secret|password|passwd|credential|authorization)/i;
function redactedMcpEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) => name.startsWith('MCP_'))
      .map(([name, value]) => [name, SECRET_NAME_PATTERN.test(name) ? '***' : value])
  );
}

if (isStdioMcp) {
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
      if (diagEnabled) {
        // 只记录开头一小段，足够判断协议是否被污染
        diagLog('[stdout->]', trimmed.slice(0, 200));
      }
      // 只有以 { 或 [ 开头的才是 MCP JSON-RPC，其他一律扔 stderr
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return origStdoutWrite(chunk, ...rest);
      }
      diagLog('[REDIRECTED to stderr]');
      return process.stderr.write(chunk, ...rest);
    } catch {
      return origStdoutWrite(chunk, ...rest);
    }
  }) as typeof process.stdout.write;

  if (diagEnabled) {
    diagLog('=== stdio-bootstrap active, pid=' + process.pid + ' ===');
    diagLog('cwd=' + process.cwd());
    diagLog('argv=' + JSON.stringify(process.argv));
    diagLog('env MCP_*=' + JSON.stringify(redactedMcpEnv()));

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
}

export const STDIO_BOOTSTRAP_ACTIVE = isStdioMcp;
export const STDIO_DIAG_LOG_PATH = __diagLogPath;
export { diagLog };
