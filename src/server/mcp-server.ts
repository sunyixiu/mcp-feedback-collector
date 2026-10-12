/**
 * MCP Feedback Collector - MCP服务器实现
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, TextContent, ImageContent, SetLevelRequestSchema, LoggingMessageNotificationSchema, ProgressToken } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { Config, FeedbackData, FeedbackSessionSnapshot, ImageData, MCPError, MCPLogLevel, MCPLogMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { WebServer } from './web-server.js';
import { PendingInstructionStore } from '../utils/pending-instruction-store.js';

// 心跳间隔（毫秒）。用 ping 请求（双向）替代 log notification，Cursor V2 FSM 只认 client/server 双向流量
const HEARTBEAT_INTERVAL_MS = 30000;
// 心跳连续失败多少次后销毁会话。
// 2026-07-03 调整 3 → 20（约 10 分钟容忍）：Cursor 客户端在跑重活（本地批量 TTS、大文件打包等）时
// 会几分钟不回 ping，旧阈值 3 次(约1分钟)就把会话杀了，导致用户正在 feedback 窗口打字时对话突然中断，
// 必须手动关开 MCP 才能重连。会话本身占用极小，宁可长时间保留也不要误杀活会话。
const HEARTBEAT_MAX_FAILURES = 20;

/**
 * HTTP 模式下的单个客户端会话
 * 每个 Cursor 窗口 initialize 时创建一个，互不干扰
 */
interface HttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatFailures: number;
  createdAt: number;
}

/**
 * MCP服务器类
 */
export class MCPServer {
  private mcpServer: McpServer;
  private webServer: WebServer;
  private config: Config;
  private isRunning = false;
  private isMcpRunning = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatFailures = 0;
  private httpSessions = new Map<string, HttpSession>();
  private transportMode: 'stdio' | 'http' = 'stdio';

  constructor(config: Config) {
    this.config = config;

    // stdio 模式使用的默认实例（HTTP 模式下每个会话有自己的实例）
    this.mcpServer = this.createServerInstance();

    // 创建Web服务器实例
    this.webServer = new WebServer(config);

    // 设置全局日志回调（广播到所有活跃会话）
    this.setupLogging();
  }

  /**
   * 创建一个完整的 McpServer 实例（含工具注册和日志处理）
   * HTTP 多会话模式下每个客户端会话独享一个实例
   */
  private createServerInstance(): McpServer {
    const server = new McpServer({
      name: 'mcp-feedback-collector',
      version: '2.3.0'
    }, {
      capabilities: {
        tools: {},
        logging: {}
      }
    });

    server.server.oninitialized = () => {
      logger.info('MCP初始化完成');
    };

    this.registerTools(server);

    // 处理日志级别设置请求（每个实例都要注册）
    server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
      const level = request.params.level as MCPLogLevel;
      logger.setMCPLogLevel(level);
      logger.info(`MCP日志级别已设置为: ${level}`);
      return {};
    });

    return server;
  }

  /**
   * 从各种可能的参数名中提取 work_summary 内容
   * AI 模型经常用错参数名，这里做兼容处理
   */
  private extractWorkSummary(args: Record<string, unknown>): string {
    const aliasKeys = [
      'work_summary',
      'workSummary',
      'work-summary',
      'summary',
      'message',
      'content',
      'text',
      'feedback',
      'description',
      'report',
      'work_report',
      'workReport',
      'result',
      'output',
      'detail',
      'details',
      'body',
      'info',
      'note',
      'notes',
      'comment',
      'task_summary',
      'taskSummary',
      'question',
      'prompt',
      'ask',
    ];

    for (const key of aliasKeys) {
      if (args[key] !== undefined && args[key] !== null) {
        const val = args[key];
        if (typeof val === 'string' && val.trim().length > 0) {
          if (key !== 'work_summary') {
            logger.info(`参数兼容: 将 "${key}" 映射为 "work_summary"`);
          }
          return val;
        }
      }
    }

    for (const [key, val] of Object.entries(args)) {
      if (typeof val === 'string' && val.trim().length > 0) {
        logger.info(`参数兜底: 将未知参数 "${key}" 作为 work_summary 使用`);
        return val;
      }
    }

    return '(AI未提供工作汇报内容)';
  }

  /**
   * 注册MCP工具函数
   */
  private registerTools(mcpServer: McpServer): void {
    // ========== 异步反馈句柄 ==========
    mcpServer.registerTool(
      'collect_feedback',
      {
        description:
          'Create a feedback session and return immediately. The result contains session_id. ' +
          'After this tool returns, call wait_feedback with that session_id (max 45 seconds per call), ' +
          'then poll_feedback if needed. Do not call collect_feedback repeatedly for the same session.',
        inputSchema: {
          work_summary: z.string().optional().describe('AI工作汇报内容，描述AI完成的工作和结果'),
          summary: z.string().optional().describe('Alias for work_summary'),
          message: z.string().optional().describe('Alias for work_summary'),
          content: z.string().optional().describe('Alias for work_summary'),
          text: z.string().optional().describe('Alias for work_summary'),
          feedback: z.string().optional().describe('Alias for work_summary'),
          description: z.string().optional().describe('Alias for work_summary'),
          report: z.string().optional().describe('Alias for work_summary'),
          question: z.string().optional().describe('Alias for work_summary'),
          prompt: z.string().optional().describe('Alias for work_summary')
        }
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const workSummary = this.extractWorkSummary(args);
        const timeoutSeconds = this.config.dialogTimeout;
        await this.ensureWebServer();
        const session = await this.webServer.createFeedbackSession(workSummary, timeoutSeconds);
        logger.mcp('collect_feedback', { work_summary: workSummary, session_id: session.session_id }, session);
        return {
          content: [{
            type: 'text',
            text: [
              '反馈会话已创建，MCP 请求已立即返回。',
              `session_id: ${session.session_id}`,
              'status: waiting',
              `反馈页面: ${this.getFeedbackUrlFromSnapshot(session)}`,
              '下一步：调用 wait_feedback({ session_id, wait_seconds: 45 })；若仍为 waiting，再调用 wait_feedback 或 poll_feedback。'
            ].join('\n')
          }],
          isError: false
        };
      }
    );

    mcpServer.registerTool(
      'wait_feedback',
      {
        description:
          'Wait briefly for a feedback session. Each call lasts at most 45 seconds. ' +
          'Use the session_id returned by collect_feedback. If status is waiting, call again later.',
        inputSchema: {
          session_id: z.string().min(1).describe('collect_feedback返回的session_id'),
          wait_seconds: z.number().int().min(1).max(45).optional().describe('本次最多等待秒数，默认45秒')
        }
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const sessionId = typeof args['session_id'] === 'string' ? args['session_id'] : '';
        const waitSeconds = typeof args['wait_seconds'] === 'number' ? args['wait_seconds'] : 45;
        await this.ensureWebServer();
        const result = await this.webServer.waitForFeedback(sessionId, waitSeconds);
        return this.formatFeedbackSessionResult(result);
      }
    );

    mcpServer.registerTool(
      'poll_feedback',
      {
        description:
          'Immediately query a feedback session without waiting. Use after wait_feedback returns waiting, ' +
          'or to recover a result after a client reconnects.',
        inputSchema: {
          session_id: z.string().min(1).describe('collect_feedback返回的session_id')
        }
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const sessionId = typeof args['session_id'] === 'string' ? args['session_id'] : '';
        await this.ensureWebServer();
        const result = this.webServer.pollFeedback(sessionId);
        return this.formatFeedbackSessionResult(result);
      }
    );

    // ========== check_pending_instructions ==========
    // 取出（FIFO）+ 立即从 pending 队列移除 + 归档到 history
    // agent 工作流：
    //   每次 collect_feedback 之前先调这个，
    //   返回非空 → 先把这些指令做掉再调本工具直到空 → 再 collect_feedback
    mcpServer.registerTool(
      'check_pending_instructions',
      {
        description:
          'Check if the user has inserted any out-of-band instructions during your work. ' +
          'Call this BEFORE collect_feedback. If the returned list is non-empty, ' +
          'address those instructions first (FIFO order), then call this tool again. ' +
          'Only call collect_feedback when this tool returns an empty list.',
        inputSchema: {}
      },
      async (): Promise<CallToolResult> => {
        try {
          const taken = PendingInstructionStore.consumeAll();
          if (!taken.length) {
            return {
              content: [{ type: 'text', text: 'NO_PENDING_INSTRUCTIONS' }],
              isError: false
            };
          }
          const lines = [
            `PENDING_INSTRUCTIONS_FOUND count=${taken.length}`,
            'Process them in order. Each line below is one instruction:',
            ...taken.map((t, idx) => `[#${idx + 1}] ${t.content}`),
            '',
            'After completing them, call check_pending_instructions again to check for more.',
          ];
          logger.info(`check_pending_instructions: 取走 ${taken.length} 条`);
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: false
          };
        } catch (error) {
          logger.error('check_pending_instructions failed:', error);
          return {
            content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
            isError: true
          };
        }
      }
    );

    if (logger.getLevel() !== 'silent') {
      logger.info('MCP工具函数注册完成');
    }
  }

  /**
   * 设置MCP日志功能（全局回调，只设置一次）
   */
  private setupLogging(): void {
    logger.setMCPLogCallback((message: MCPLogMessage) => {
      this.sendLogNotification(message).catch(() => {
        // 静默处理错误，避免未处理的Promise拒绝
      });
    });

    logger.info('MCP日志功能已设置');
  }

  /**
   * 发送MCP日志通知
   * stdio 模式发给默认实例；HTTP 模式广播给所有活跃会话
   */
  private async sendLogNotification(message: MCPLogMessage): Promise<void> {
    const payload = {
      method: 'notifications/message' as const,
      params: {
        level: message.level,
        logger: message.logger,
        data: message.data
      }
    };

    const targets: McpServer[] = this.transportMode === 'http'
      ? [...this.httpSessions.values()].map(s => s.server)
      : [this.mcpServer];

    for (const server of targets) {
      try {
        await server.server.notification(payload);
      } catch {
        // 单个会话通知失败不影响其他会话
      }
    }
  }

  private async ensureWebServer(): Promise<void> {
    if (!this.webServer.isRunning()) {
      await this.webServer.start();
    }
  }

  private getFeedbackUrlFromSnapshot(snapshot: FeedbackSessionSnapshot): string {
    return snapshot.feedback_url
      || this.config.serverBaseUrl
      || `http://${this.config.serverHost || 'localhost'}:${this.webServer.getPort()}`;
  }

  private formatFeedbackSessionResult(result: FeedbackSessionSnapshot): CallToolResult {
    if (result.status === 'completed' || result.status === 'timed_out') {
      const content = this.formatFeedbackForMCP(result.feedback || []);
      content.unshift({
        type: 'text',
        text: `反馈会话 ${result.session_id} 状态: ${result.status}`
      });
      return { content, isError: false };
    }

    if (result.status === 'not_found' || result.status === 'error' || result.status === 'cancelled') {
      return {
        content: [{
          type: 'text',
          text: `反馈会话 ${result.session_id} 状态: ${result.status}。${result.message || ''}`.trim()
        }],
        isError: result.status === 'not_found' || result.status === 'error'
      };
    }

    return {
      content: [{
        type: 'text',
        text: [
          `反馈会话 ${result.session_id} 仍在等待用户回复。`,
          'status: waiting',
          `remaining_seconds: ${result.remaining_seconds ?? 0}`,
          '请稍后再次调用 wait_feedback，或使用 poll_feedback 立即查询。'
        ].join('\n')
      }],
      isError: false
    };
  }

  /**
   * 将反馈数据格式化为MCP内容（支持图片显示）
   */
  private formatFeedbackForMCP(feedback: FeedbackData[]): (TextContent | ImageContent)[] {
    if (feedback.length === 0) {
      return [{
        type: 'text',
        text: '未收到用户反馈'
      }];
    }

    const content: (TextContent | ImageContent)[] = [];

    // 添加总结文本
    content.push({
      type: 'text',
      text: `收到 ${feedback.length} 条用户反馈：\n`
    });

    feedback.forEach((item, index) => {
      // 添加反馈标题
      content.push({
        type: 'text',
        text: `\n--- 反馈 ${index + 1} ---`
      });

      // 添加文字反馈
      if (item.text) {
        content.push({
          type: 'text',
          text: `文字反馈: ${item.text}`
        });
      }

      // 添加图片（转换为base64格式）
      if (item.images && item.images.length > 0) {
        content.push({
          type: 'text',
          text: `图片数量: ${item.images.length}`
        });

        item.images.forEach((img: ImageData, imgIndex: number) => {
          // 添加图片信息
          content.push({
            type: 'text',
            text: `图片 ${imgIndex + 1}: ${img.name} (${img.type}, ${(img.size / 1024).toFixed(1)}KB)`
          });

          // 添加图片描述（如果有）
          if (item.imageDescriptions && item.imageDescriptions[imgIndex]) {
            content.push({
              type: 'text',
              text: `图片描述: ${item.imageDescriptions[imgIndex]}`
            });
          }

          // 添加图片内容（Cursor格式）
          if (img.data) {
            // 确保是纯净的base64数据（移除data:image/...;base64,前缀）
            const base64Data = img.data.replace(/^data:image\/[^;]+;base64,/, '');

            content.push({
              type: 'image',
              data: base64Data, // 纯净的base64字符串
              mimeType: img.type
            });
          }
        });
      }

      // 添加时间戳
      content.push({
        type: 'text',
        text: `提交时间: ${new Date(item.timestamp).toLocaleString()}\n`
      });
    });

    return content;
  }

  /**
   * 将反馈数据格式化为文本（保留用于其他用途）
   */
  private formatFeedbackAsText(feedback: FeedbackData[]): string {
    if (feedback.length === 0) {
      return '未收到用户反馈';
    }

    const parts: string[] = [];
    parts.push(`收到 ${feedback.length} 条用户反馈：\n`);

    feedback.forEach((item, index) => {
      parts.push(`--- 反馈 ${index + 1} ---`);

      if (item.text) {
        parts.push(`文字反馈: ${item.text}`);
      }

      if (item.images && item.images.length > 0) {
        parts.push(`图片数量: ${item.images.length}`);
        item.images.forEach((img: ImageData, imgIndex: number) => {
          parts.push(`  图片 ${imgIndex + 1}: ${img.name} (${img.type}, ${(img.size / 1024).toFixed(1)}KB)`);
        });
      }

      parts.push(`提交时间: ${new Date(item.timestamp).toLocaleString()}`);
      parts.push('');
    });

    return parts.join('\n');
  }

  /**
   * 启动MCP服务器
   * 根据环境变量 MCP_TRANSPORT_MODE 选择传输：
   *   - stdio（默认）：作为 Cursor 的 stdio 子进程
   *   - http：作为独立进程，暴露 Streamable HTTP 端点 /mcp 在 webServer 上
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('MCP服务器已在运行中');
      return;
    }

    const envMode = (process.env['MCP_TRANSPORT_MODE'] || 'stdio').toLowerCase();
    this.transportMode = envMode === 'http' ? 'http' : 'stdio';

    try {
      logger.info(`正在启动MCP服务器 (transport=${this.transportMode})...`);

      if (this.transportMode === 'http') {
        await this.startHttpMode();
      } else {
        await this.startStdioMode();
      }

      this.isRunning = true;
      this.isMcpRunning = true;
      logger.info('MCP服务器启动成功');

      // 全局心跳仅 stdio 模式需要；HTTP 模式改为每会话独立心跳
      if (this.transportMode === 'stdio') {
        this.startHeartbeat();
      }

    } catch (error) {
      logger.error('MCP服务器启动失败:', error);
      throw new MCPError(
        'Failed to start MCP server',
        'SERVER_START_ERROR',
        error
      );
    }
  }

  /**
   * 启动 stdio 模式（作为 Cursor 子进程）
   */
  private async startStdioMode(): Promise<void> {
    const transport = new StdioServerTransport();

    transport.onerror = (error: Error) => {
      logger.error('MCP传输错误:', error);
    };

    transport.onclose = () => {
      logger.info('MCP stdio 传输连接已关闭');
      this.isRunning = false;
      this.isMcpRunning = false;
      this.stopHeartbeat();
    };

    // 添加消息调试
    const originalOnMessage = transport.onmessage;
    transport.onmessage = (message) => {
      logger.debug('📥 收到MCP消息:', JSON.stringify(message, null, 2));
      if (originalOnMessage) {
        originalOnMessage(message);
      }
    };

    const originalSend = transport.send.bind(transport);
    transport.send = (message) => {
      logger.debug('📤 发送MCP消息:', JSON.stringify(message, null, 2));
      return originalSend(message);
    };

    await this.mcpServer.connect(transport);

    // 启动Web服务器（在MCP连接建立后）
    await this.webServer.start();
  }

  /**
   * 启动 HTTP/SSE 模式（独立进程，Cursor 通过 url 连接）
   * 使用 Streamable HTTP transport，支持 SSE 流式推送
   *
   * 多会话设计（v2.1.4）：
   * - 按 mcp-session-id 维护 transport map，每个 Cursor 窗口一个独立会话
   * - 新客户端 initialize 只新建自己的会话，不再拆掉别人的 transport
   *   （旧版单 transport 设计会导致：窗口 A 正挂着 collect_feedback 等用户反馈时，
   *    窗口 B 的 initialize 把通道拆了，A 的结果永远回不去）
   * - 每个会话独立心跳，连续失败则只销毁该会话
   */
  private async startHttpMode(): Promise<void> {
    // 先启动 webServer，因为 /mcp 路由要挂在它上面
    await this.webServer.start();

    // 把 /mcp 路由挂到 webServer 上
    this.webServer.attachMcpTransport(async (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => {
      const body = parsedBody as { method?: string; jsonrpc?: string } | undefined;
      const sessionIdHeader = req.headers['mcp-session-id'] as string | undefined;

      // 1) 带 session id 的请求 → 路由到对应会话
      if (sessionIdHeader) {
        const session = this.httpSessions.get(sessionIdHeader);
        if (session) {
          await session.transport.handleRequest(req, res, parsedBody);
          return;
        }
        // 未知/已过期的 session → 404，让客户端按规范重新 initialize
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null
        }));
        return;
      }

      // 2) 无 session id 且是 initialize → 新建会话
      if (body?.method === 'initialize') {
        try {
          await this.createHttpSession(req, res, parsedBody);
        } catch (e) {
          logger.error('创建 HTTP 会话失败:', e);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Failed to create MCP session');
          }
        }
        return;
      }

      // 3) 其他无 session 请求 → 400
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: missing mcp-session-id' },
        id: null
      }));
    });

    logger.info('HTTP 多会话模式已就绪（等待客户端 initialize）');
  }

  /**
   * 为一个新客户端建立独立会话（独享 McpServer 实例 + transport + 心跳）
   */
  private async createHttpSession(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    const server = this.createServerInstance();

    const session: HttpSession = {
      server,
      transport: null as unknown as StreamableHTTPServerTransport,
      heartbeatTimer: null,
      heartbeatFailures: 0,
      createdAt: Date.now()
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        this.httpSessions.set(sessionId, session);
        this.startSessionHeartbeat(sessionId, session);
        logger.info(`新 MCP 会话已建立: ${sessionId}（当前并发会话数: ${this.httpSessions.size}）`);
      }
    });
    session.transport = transport;

    transport.onerror = (error: Error) => {
      logger.error(`MCP HTTP 传输错误 (session=${transport.sessionId}):`, error);
    };

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && this.httpSessions.has(sid)) {
        logger.info(`MCP 会话已关闭: ${sid}`);
        this.destroyHttpSession(sid, false);
      }
    };

    // SDK 的 StreamableHTTPServerTransport 和 Transport 接口在 exactOptionalPropertyTypes 下有 onclose 可选性不一致
    await server.connect(transport as any);
    await transport.handleRequest(req, res, parsedBody);
  }

  /**
   * 销毁一个 HTTP 会话（停心跳、移出 map、关 transport）
   */
  private destroyHttpSession(sessionId: string, closeTransport = true): void {
    const session = this.httpSessions.get(sessionId);
    if (!session) {
      return;
    }
    this.httpSessions.delete(sessionId);
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    if (closeTransport) {
      session.transport.close().catch(e => {
        logger.warn(`关闭会话 ${sessionId} 的 transport 出错:`, e);
      });
    }
    logger.info(`会话已销毁: ${sessionId}（剩余并发会话数: ${this.httpSessions.size}）`);
  }

  /**
   * 每个会话独立心跳，连续失败只销毁自己，不影响其他会话
   */
  private startSessionHeartbeat(sessionId: string, session: HttpSession): void {
    session.heartbeatTimer = setInterval(async () => {
      if (!this.httpSessions.has(sessionId)) {
        if (session.heartbeatTimer) {
          clearInterval(session.heartbeatTimer);
          session.heartbeatTimer = null;
        }
        return;
      }
      try {
        await session.server.server.ping();
        if (session.heartbeatFailures > 0) {
          logger.info(`会话 ${sessionId} 心跳恢复（之前失败 ${session.heartbeatFailures} 次）`);
        }
        session.heartbeatFailures = 0;
      } catch (error) {
        session.heartbeatFailures++;
        logger.warn(`会话 ${sessionId} 心跳失败 ${session.heartbeatFailures}/${HEARTBEAT_MAX_FAILURES}: ${error instanceof Error ? error.message : String(error)}`);
        if (session.heartbeatFailures >= HEARTBEAT_MAX_FAILURES) {
          logger.error(`会话 ${sessionId} 连续 ${HEARTBEAT_MAX_FAILURES} 次心跳失败，销毁该会话`);
          this.destroyHttpSession(sessionId);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 获取当前传输模式
   */
  getTransportMode(): 'stdio' | 'http' {
    return this.transportMode;
  }

  /**
   * 仅启动Web模式
   */
  async startWebOnly(): Promise<void> {
    try {
      logger.info('正在启动Web模式...');
      
      // 仅启动Web服务器
      await this.webServer.start();
      
      this.isRunning = true;
      logger.info('Web服务器启动成功');
      
      // 保持进程运行
      process.stdin.resume();
      
    } catch (error) {
      logger.error('Web服务器启动失败:', error);
      throw new MCPError(
        'Failed to start web server',
        'WEB_SERVER_START_ERROR',
        error
      );
    }
  }

  /**
   * 启动心跳保活
   *
   * 设计要点：
   * 1. 用 ping() 请求（server→client→server 双向 JSON-RPC）代替单向 notification
   *    —— Cursor 2026 V2 FSM 只把双向流量算作活跃信号，单向 log 不重置 idle timer
   * 2. 不 .unref() —— 保持 event loop 活跃，防止 Node 进程在无活跃句柄时退出
   * 3. 连续失败 HEARTBEAT_MAX_FAILURES 次则标记 transport 异常
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatFailures = 0;

    this.heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) {
        this.stopHeartbeat();
        return;
      }

      try {
        await this.mcpServer.server.ping();
        if (this.heartbeatFailures > 0) {
          logger.info(`心跳恢复（之前失败 ${this.heartbeatFailures} 次）`);
        }
        this.heartbeatFailures = 0;
      } catch (error) {
        this.heartbeatFailures++;
        logger.warn(`心跳失败 ${this.heartbeatFailures}/${HEARTBEAT_MAX_FAILURES}: ${error instanceof Error ? error.message : String(error)}`);

        if (this.heartbeatFailures >= HEARTBEAT_MAX_FAILURES) {
          logger.error(`连续 ${HEARTBEAT_MAX_FAILURES} 次心跳失败，transport 可能已断开`);
          this.stopHeartbeat();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 注意：故意不调用 unref()，保持进程 event loop 活跃
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      logger.info('正在停止服务器...');

      this.stopHeartbeat();

      // 销毁所有 HTTP 会话（如果存在）
      for (const sessionId of [...this.httpSessions.keys()]) {
        this.destroyHttpSession(sessionId);
      }

      // 停止Web服务器
      await this.webServer.stop();

      // 关闭MCP服务器
      if (this.mcpServer) {
        await this.mcpServer.close();
      }

      this.isRunning = false;
      this.isMcpRunning = false;
      logger.info('服务器已停止');
      
    } catch (error) {
      logger.error('停止服务器时出错:', error);
      throw new MCPError(
        'Failed to stop server',
        'SERVER_STOP_ERROR',
        error
      );
    }
  }

  /**
   * 获取服务器状态
   */
  getStatus(): {
    running: boolean;
    webRunning: boolean;
    webPort?: number | undefined;
    mcpRunning: boolean;
  } {
    const webRunning = this.webServer.isRunning();
    return {
      running: this.isRunning,
      webRunning,
      webPort: webRunning ? this.webServer.getPort() : undefined,
      mcpRunning: this.isMcpRunning
    };
  }
}
