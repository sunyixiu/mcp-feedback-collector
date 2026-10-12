/**
 * MCP Feedback Collector - Web服务器实现
 */

import express from 'express';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import { Config, FeedbackData, FeedbackSessionSnapshot, MCPError, ConvertImagesRequest, ConvertImagesResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { PortManager } from '../utils/port-manager.js';
import { ImageProcessor } from '../utils/image-processor.js';
import { ImageToTextService } from '../utils/image-to-text-service.js';
import { performanceMonitor } from '../utils/performance-monitor.js';
import { SessionStorage, SessionData } from '../utils/session-storage.js';
import { PendingInstructionStore } from '../utils/pending-instruction-store.js';
import { VERSION } from '../index.js';

/** MCP Streamable HTTP transport 处理函数类型（被 mcp-server.ts 注入） */
export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>;

/**
 * Web服务器类
 */
export class WebServer {
  private app: express.Application;
  private server: any;
  private io: SocketIOServer;
  private config: Config;
  private port: number = 0;
  private isServerRunning = false;
  private portManager: PortManager;
  private imageProcessor: ImageProcessor;
  private imageToTextService: ImageToTextService;
  private sessionStorage: SessionStorage;
  private mcpHttpHandler: McpHttpHandler | null = null;
  // 服务端权威超时：每个会话一个精确定时器（不受浏览器后台节流影响），
  // 连续超时熔断计数也在服务端做（页面刷新不丢）。
  private sessionTimers = new Map<string, NodeJS.Timeout>();
  private consecutiveTimeouts = 0;
  private static readonly MAX_CONSECUTIVE_TIMEOUTS = 3;
  private static readonly RESULT_RETENTION_MS = 10 * 60 * 1000;
  private static readonly MAX_WAIT_SECONDS = 45;

  constructor(config: Config) {
    this.config = config;
    this.portManager = new PortManager();
    this.imageProcessor = new ImageProcessor({
      maxFileSize: config.maxFileSize,
      maxWidth: 2048,
      maxHeight: 2048
    });
    this.imageToTextService = new ImageToTextService(config);
    this.sessionStorage = new SessionStorage();

    // 创建Express应用
    this.app = express();
    
    // 创建HTTP服务器
    this.server = createServer(this.app);
    
    // 创建Socket.IO服务器
    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: config.corsOrigin,
        methods: ['GET', 'POST']
      },
      // 默认 maxHttpBufferSize 仅 1MB，>1MB 的截图走 websocket 会直接断连（"发不出去"）。
      // 提到 100MB，并放宽 ping 超时，避免大图传输期间被误判离线。
      maxHttpBufferSize: 100 * 1024 * 1024,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupGracefulShutdown();
  }

  /**
   * 设置优雅退出处理
   */
  private setupGracefulShutdown(): void {
    let isShuttingDown = false;

    // 注册退出信号处理
    const gracefulShutdown = async (signal: string) => {
      if (isShuttingDown) {
        logger.warn(`已在关闭过程中，忽略 ${signal} 信号`);
        return;
      }

      isShuttingDown = true;
      logger.info(`收到 ${signal} 信号，开始优雅关闭...`);

      try {
        await this.gracefulStop();
        logger.info('优雅关闭完成');
        process.exit(0);
      } catch (error) {
        logger.error('优雅关闭失败:', error);
        process.exit(1);
      }
    };

    // 标准退出信号
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Windows特有的退出信号
    if (process.platform === 'win32') {
      process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
    }

    // 未捕获的异常
    process.on('uncaughtException', async (error) => {
      if (isShuttingDown) return;

      isShuttingDown = true;
      logger.error('未捕获的异常:', error);
      try {
        await this.gracefulStop();
      } catch (stopError) {
        logger.error('异常退出时清理失败:', stopError);
      }
      process.exit(1);
    });

    // 未处理的Promise拒绝 - 只记录，不退出
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('未处理的Promise拒绝:', reason);
      logger.debug('Promise:', promise);
      // 不要因为Promise拒绝就退出程序，这在MCP环境中很常见
    });
  }

  /**
   * 设置中间件
   */
  private setupMiddleware(): void {
    // 安全中间件
    this.app.use(helmet({
      contentSecurityPolicy: false // 允许内联脚本
    }));
    
    // 压缩中间件
    this.app.use(compression());
    
    // CORS中间件
    this.app.use(cors({
      origin: this.config.corsOrigin,
      credentials: true
    }));
    
    // JSON解析中间件
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    
    // 请求日志和性能监控中间件
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        const success = res.statusCode < 400;

        // 记录请求日志
        logger.request(req.method, req.url, res.statusCode, duration);

        // 记录性能指标
        performanceMonitor.recordRequest(duration, success);

        // 记录慢请求
        if (duration > 1000) {
          logger.warn(`慢请求: ${req.method} ${req.path} - ${duration}ms`);
        }
      });
      next();
    });
  }

  /**
   * 设置路由
   */
  private setupRoutes(): void {
    // 获取当前文件的目录路径（ES模块兼容）
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const staticPath = path.resolve(__dirname, '../static');

    // 静态文件服务 - 使用绝对路径
    this.app.use(express.static(staticPath));

    // 主页路由
    this.app.get('/', (req, res) => {
      res.sendFile('index.html', { root: staticPath });
    });

    // API配置路由
    this.app.get('/api/config', (req, res) => {
      const chatConfig = {
        api_key: this.config.apiKey || null,
        api_base_url: this.config.apiBaseUrl || 'https://api.openai.com/v1',
        model: this.config.defaultModel || 'gpt-4o-mini',
        enable_chat: this.config.enableChat !== false, // 默认启用
        max_file_size: this.config.maxFileSize,
        temperature: 0.7,
        max_tokens: 2000
      };

      logger.info('返回聊天配置:', {
        hasApiKey: !!chatConfig.api_key,
        apiBaseUrl: chatConfig.api_base_url,
        model: chatConfig.model,
        enableChat: chatConfig.enable_chat
      });

      res.json(chatConfig);
    });

    // 测试会话创建路由
    this.app.post('/api/test-session', (req, res) => {
      const { work_summary, timeout_seconds = 300 } = req.body;

      if (!work_summary) {
        res.status(400).json({ error: '缺少work_summary参数' });
        return;
      }

      const sessionId = this.generateSessionId();

      // 创建测试会话
      const session: SessionData = {
        workSummary: work_summary,
        feedback: [],
        startTime: Date.now(),
        timeout: timeout_seconds * 1000,
        status: 'waiting'
      };

      this.sessionStorage.createSession(sessionId, session);

      // 记录会话创建
      performanceMonitor.recordSessionCreated();

      logger.info(`创建测试会话: ${sessionId}`);

      res.json({
        success: true,
        session_id: sessionId,
        feedback_url: this.generateFeedbackUrl(sessionId)
      });
    });

    // 版本信息API
    this.app.get('/api/version', (req, res) => {
      res.json({
        version: VERSION,
        timestamp: new Date().toISOString()
      });
    });

    // 健康检查路由
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: VERSION,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        active_sessions: this.sessionStorage.getSessionCount()
      });
    });

    // 性能监控路由
    this.app.get('/api/metrics', (req, res) => {
      const metrics = performanceMonitor.getMetrics();
      res.json(metrics);
    });

    // 性能报告路由
    this.app.get('/api/performance-report', (req, res) => {
      const report = performanceMonitor.getFormattedReport();
      res.type('text/plain').send(report);
    });

    // ========== 临时指令（pending instructions）======================
    // 用户可以在 Web UI 上插入“临时任务”，agent 在 collect_feedback 之前会先取走。
    // 设计：FIFO + 取出即删 + 历史保留 24h
    // ===============================================================

    // 列出当前 pending（仅供 UI 展示）
    this.app.get('/api/pending-instructions', (req, res) => {
      try {
        res.json({ success: true, instructions: PendingInstructionStore.list() });
      } catch (e) {
        res.status(500).json({ success: false, error: (e as Error).message });
      }
    });

    // 列出最近 24h 已被消费的（用户回查 agent 是否真的做了）
    this.app.get('/api/pending-instructions/history', (req, res) => {
      try {
        res.json({ success: true, history: PendingInstructionStore.history() });
      } catch (e) {
        res.status(500).json({ success: false, error: (e as Error).message });
      }
    });

    // 添加一条临时指令
    this.app.post('/api/pending-instructions', (req, res) => {
      try {
        const { content } = req.body || {};
        if (!content || typeof content !== 'string' || !content.trim()) {
          res.status(400).json({ success: false, error: 'content is required' });
          return;
        }
        const inst = PendingInstructionStore.add(content);
        logger.info(`新临时指令插入: id=${inst.id} len=${inst.content.length}`);
        res.json({
          success: true,
          instruction: inst,
          pendingCount: PendingInstructionStore.list().length,
        });
      } catch (e) {
        res.status(500).json({ success: false, error: (e as Error).message });
      }
    });

    // 取消一条 pending（用户插错了想删）
    this.app.delete('/api/pending-instructions/:id', (req, res) => {
      try {
        const ok = PendingInstructionStore.cancel(req.params.id);
        res.json({ success: ok });
      } catch (e) {
        res.status(500).json({ success: false, error: (e as Error).message });
      }
    });

    // 一键清空 pending（不动 history）
    this.app.delete('/api/pending-instructions', (req, res) => {
      try {
        const n = PendingInstructionStore.clearPending();
        res.json({ success: true, cleared: n });
      } catch (e) {
        res.status(500).json({ success: false, error: (e as Error).message });
      }
    });

    // 图片转文字API
    this.app.post('/api/convert-images', async (req, res) => {
      try {
        const { images }: ConvertImagesRequest = req.body;

        if (!images || !Array.isArray(images) || images.length === 0) {
          res.status(400).json({
            success: false,
            error: '请提供要转换的图片数据'
          } as ConvertImagesResponse);
          return;
        }

        // 检查功能是否启用
        if (!this.imageToTextService.isEnabled()) {
          res.status(400).json({
            success: false,
            error: '图片转文字功能未启用或API密钥未配置'
          } as ConvertImagesResponse);
          return;
        }

        logger.info(`开始转换 ${images.length} 张图片为文字`);

        // 批量转换图片
        const descriptions = await this.imageToTextService.convertMultipleImages(images);

        logger.info(`图片转文字完成，共转换 ${descriptions.length} 张图片`);

        res.json({
          success: true,
          descriptions
        } as ConvertImagesResponse);

      } catch (error) {
        logger.error('图片转文字API错误:', error);
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : '图片转文字处理失败'
        } as ConvertImagesResponse);
      }
    });

    // MCP Streamable HTTP 端点（Cursor 通过 url 模式连接时使用）
    // 注意：此路由必须在所有 body-parser 之后、错误处理之前
    // 支持 GET/POST/DELETE 三种方法（SDK StreamableHTTPServerTransport 规范）
    const mcpRouteHandler = async (req: express.Request, res: express.Response) => {
      if (!this.mcpHttpHandler) {
        res.status(503).json({ error: 'MCP HTTP transport not attached' });
        return;
      }
      try {
        // req.body 已被 express.json() 解析过，传给 SDK 避免重复读流
        await this.mcpHttpHandler(req as unknown as IncomingMessage, res as unknown as ServerResponse, req.body);
      } catch (error) {
        logger.error('MCP HTTP 路由处理错误:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal MCP transport error' });
        }
      }
    };
    this.app.all('/mcp', mcpRouteHandler);

    // 错误处理中间件
    this.app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Express错误:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    });
  }

  /**
   * 注入 MCP HTTP transport handler（由 mcp-server.ts 在启动 HTTP 模式时调用）
   */
  attachMcpTransport(handler: McpHttpHandler): void {
    this.mcpHttpHandler = handler;
    logger.info('MCP HTTP /mcp 路由已注入');
  }

  /**
   * 解绑 MCP HTTP transport
   */
  detachMcpTransport(): void {
    this.mcpHttpHandler = null;
  }

  /**
   * 设置Socket.IO事件处理
   */
  private setupSocketHandlers(): void {
    this.io.on('connection', (socket) => {
      logger.socket('connect', socket.id);
      logger.info(`新的WebSocket连接: ${socket.id}`);

      // 记录WebSocket连接
      performanceMonitor.recordWebSocketConnection();

      // 测试消息处理
      socket.on('test_message', (data: any) => {
        logger.socket('test_message', socket.id, data);
        socket.emit('test_response', { message: 'Test message received!', timestamp: Date.now() });
      });

      // 处理会话请求（固定URL模式）
      socket.on('request_session', () => {
        logger.socket('request_session', socket.id);

        // 查找最新的活跃会话
        const activeSessions = this.sessionStorage.getAllSessions();
        let latestSession: { sessionId: string; session: any } | null = null;

        for (const [sessionId, session] of activeSessions) {
          if (session.status && session.status !== 'waiting') continue;
          if (!latestSession || session.startTime > latestSession.session.startTime) {
            latestSession = { sessionId, session };
          }
        }

        if (latestSession) {
          // 有活跃会话，分配给客户端
          // 计时锚点是 session.startTime（MCP 调用时刻），不是客户端接入时刻
          const elapsed = Date.now() - latestSession.session.startTime;
          const remaining = Math.max(5000, latestSession.session.timeout - elapsed);
          logger.info(`为客户端 ${socket.id} 分配会话: ${latestSession.sessionId}，剩余 ${Math.round(remaining / 1000)}s (已过 ${Math.round(elapsed / 1000)}s)`);
          socket.emit('session_assigned', {
            session_id: latestSession.sessionId,
            work_summary: latestSession.session.workSummary,
            timeout: remaining,                                   // 剩余时间（毫秒）
            total_timeout: latestSession.session.timeout,         // 原始设定总时长
            elapsed_ms: elapsed,                                   // 已经过去的时间
            deadline: latestSession.session.startTime + latestSession.session.timeout // 绝对截止时间戳（服务端权威）
          });
        } else {
          // 无活跃会话
          logger.info(`客户端 ${socket.id} 请求会话，但无活跃会话`);
          socket.emit('no_active_session', {
            message: '当前无活跃的反馈会话'
          });
        }
      });

      // 处理最新工作汇报请求
      socket.on('request_latest_summary', () => {
        logger.socket('request_latest_summary', socket.id);

        // 查找最新的活跃会话
        const activeSessions = this.sessionStorage.getAllSessions();
        let latestSession: { sessionId: string; session: any } | null = null;

        for (const [sessionId, session] of activeSessions) {
          if (session.status && session.status !== 'waiting') continue;
          if (!latestSession || session.startTime > latestSession.session.startTime) {
            latestSession = { sessionId, session };
          }
        }

        if (latestSession && latestSession.session.workSummary) {
          // 找到最新的工作汇报
          logger.info(`为客户端 ${socket.id} 返回最新工作汇报`);
          socket.emit('latest_summary_response', {
            success: true,
            work_summary: latestSession.session.workSummary,
            session_id: latestSession.sessionId,
            timestamp: latestSession.session.startTime,
            deadline: latestSession.session.startTime + latestSession.session.timeout
          });
        } else {
          // 没有找到工作汇报
          logger.info(`客户端 ${socket.id} 请求最新工作汇报，但未找到`);
          socket.emit('latest_summary_response', {
            success: false,
            message: '暂无最新工作汇报，请等待AI调用collect_feedback工具函数'
          });
        }
      });

      // 获取工作汇报数据
      socket.on('get_work_summary', (data: { feedback_session_id: string }) => {
        logger.socket('get_work_summary', socket.id, data);

        const session = this.sessionStorage.getSession(data.feedback_session_id);
        if (session) {
          socket.emit('work_summary_data', {
            work_summary: session.workSummary
          });
        } else {
          socket.emit('feedback_error', {
            error: '会话不存在或已过期'
          });
        }
      });

      // 保活：用户仍在页面但暂时无操作，重置 session 超时
      socket.on('keep_alive', (data: { sessionId: string }) => {
        logger.socket('keep_alive', socket.id, data);

        const session = this.sessionStorage.getSession(data.sessionId);
        if (session && (!session.status || session.status === 'waiting')) {
          session.startTime = Date.now();
          this.sessionStorage.updateSession(data.sessionId, { startTime: session.startTime });
          // 服务端权威定时器同步重置
          this.armSessionTimer(data.sessionId, session.timeout);
          logger.info(`会话 ${data.sessionId} 已保活，超时重置`);
          socket.emit('keep_alive_ack', { success: true, sessionId: data.sessionId, deadline: session.startTime + session.timeout });
        } else {
          socket.emit('keep_alive_ack', { success: false, message: '会话不存在或已过期' });
        }
      });

      // 提交反馈
      socket.on('submit_feedback', async (data: FeedbackData) => {
        logger.socket('submit_feedback', socket.id, {
          sessionId: data.sessionId,
          textLength: data.text?.length || 0,
          imageCount: data.images?.length || 0
        });

        await this.handleFeedbackSubmission(socket, data);
      });

      // 断开连接
      socket.on('disconnect', (reason) => {
        logger.socket('disconnect', socket.id, { reason });
        logger.info(`WebSocket连接断开: ${socket.id}, 原因: ${reason}`);

        // 记录WebSocket断开连接
        performanceMonitor.recordWebSocketDisconnection();
      });
    });
  }

  /**
   * 处理反馈提交
   */
  private async handleFeedbackSubmission(socket: any, feedbackData: FeedbackData): Promise<void> {
    const session = this.sessionStorage.getSession(feedbackData.sessionId);

    if (!session) {
      socket.emit('feedback_error', {
        error: '会话不存在或已过期'
      });
      return;
    }

    if (session.status && session.status !== 'waiting') {
      socket.emit('feedback_error', {
        error: session.status === 'completed' ? '该会话已经提交过反馈' : '该会话已结束，无法继续提交'
      });
      return;
    }

    try {
      if (!feedbackData.text && (!feedbackData.images || feedbackData.images.length === 0)) {
        socket.emit('feedback_error', {
          error: '请提供文字反馈或上传图片'
        });
        return;
      }

      let processedFeedback = { ...feedbackData };
      if (feedbackData.images && feedbackData.images.length > 0) {
        logger.info(`开始处理 ${feedbackData.images.length} 张图片...`);

        try {
          const processedImages = await this.imageProcessor.processImages(feedbackData.images);
          processedFeedback.images = processedImages;

          const stats = this.imageProcessor.getImageStats(processedImages);
          logger.info(`图片处理完成: ${stats.totalCount} 张图片, 总大小: ${(stats.totalSize / 1024 / 1024).toFixed(2)}MB`);
        } catch (error) {
          logger.error('图片处理失败:', error);
          socket.emit('feedback_error', {
            error: `图片处理失败: ${error instanceof Error ? error.message : '未知错误'}`
          });
          return;
        }
      }

      session.feedback.push(processedFeedback);
      session.status = 'completed';
      session.completedAt = Date.now();
      session.resultExpiresAt = session.completedAt + WebServer.RESULT_RETENTION_MS;
      this.sessionStorage.updateSession(feedbackData.sessionId, {
        feedback: session.feedback,
        status: session.status,
        completedAt: session.completedAt,
        resultExpiresAt: session.resultExpiresAt
      });

      this.clearSessionTimer(feedbackData.sessionId);
      this.consecutiveTimeouts = 0;
      this.sessionStorage.notifyWaiters(feedbackData.sessionId);

      socket.emit('feedback_submitted', {
        success: true,
        message: '反馈提交成功',
        shouldCloseAfterSubmit: feedbackData.shouldCloseAfterSubmit || false
      });

      // 兼容旧版直接等待 Promise 的调用者，但不再删除会话，便于 poll 查询。
      if (session.resolve) {
        session.resolve(session.feedback);
        delete session.resolve;
      }
    } catch (error) {
      logger.error('处理反馈提交时出错:', error);
      socket.emit('feedback_error', {
        error: '服务器处理错误，请稍后重试'
      });
    }
  }

  /**
   * 装载/重置某会话的服务端权威超时定时器
   */
  private armSessionTimer(sessionId: string, timeoutMs: number): void {
    this.clearSessionTimer(sessionId);
    const timer = setTimeout(() => this.handleSessionTimeout(sessionId), timeoutMs);
    this.sessionTimers.set(sessionId, timer);
  }

  private clearSessionTimer(sessionId: string): void {
    const t = this.sessionTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.sessionTimers.delete(sessionId);
    }
  }

  /**
   * 服务端超时处理：把等待中的会话转换为可轮询的 timed_out 状态。
   */
  private handleSessionTimeout(sessionId: string): void {
    this.clearSessionTimer(sessionId);
    const session = this.sessionStorage.getAllSessions().get(sessionId);
    if (!session || (session.status && session.status !== 'waiting')) return;

    this.consecutiveTimeouts++;
    const fused = this.consecutiveTimeouts >= WebServer.MAX_CONSECUTIVE_TIMEOUTS;
    const text = fused
      ? '用户长时间未响应，任务结束。请终止会话，不要再调用 feedback 工具。'
      : `用户暂时未回复（连续第${this.consecutiveTimeouts}/${WebServer.MAX_CONSECUTIVE_TIMEOUTS}次超时，服务端自动代答），如需继续请重新调用 collect_feedback。`;
    const now = Date.now();
    const busyFeedback: FeedbackData = {
      text,
      images: [],
      timestamp: now,
      sessionId
    };

    session.feedback = [busyFeedback];
    session.status = 'timed_out';
    session.completedAt = now;
    session.resultExpiresAt = now + WebServer.RESULT_RETENTION_MS;
    this.sessionStorage.updateSession(sessionId, {
      feedback: session.feedback,
      status: session.status,
      completedAt: session.completedAt,
      resultExpiresAt: session.resultExpiresAt
    });
    this.sessionStorage.notifyWaiters(sessionId);

    logger.info(`会话 ${sessionId} 服务端超时（连续 ${this.consecutiveTimeouts}/${WebServer.MAX_CONSECUTIVE_TIMEOUTS}${fused ? '，熔断' : ''}），状态已保存供 poll 查询`);
    this.io.emit('session_timed_out', {
      session_id: sessionId,
      fused,
      count: this.consecutiveTimeouts,
      max: WebServer.MAX_CONSECUTIVE_TIMEOUTS
    });

    if (session.resolve) {
      session.resolve([busyFeedback]);
      delete session.resolve;
    }
    if (fused) {
      this.consecutiveTimeouts = 0;
    }
  }

  /**
   * 创建反馈会话，立即返回句柄，不在 MCP 请求中等待浏览器回复。
   */
  async createFeedbackSession(workSummary: string, timeoutSeconds: number): Promise<FeedbackSessionSnapshot> {
    if (!this.isServerRunning) {
      await this.start();
    }

    const sessionId = this.generateSessionId();
    const now = Date.now();
    const timeoutMs = Math.max(10, timeoutSeconds) * 1000;
    const session: SessionData = {
      workSummary,
      feedback: [],
      startTime: now,
      timeout: timeoutMs,
      status: 'waiting'
    };

    this.sessionStorage.createSession(sessionId, session);
    this.armSessionTimer(sessionId, timeoutMs);
    performanceMonitor.recordSessionCreated();

    const feedbackUrl = this.generateFeedbackUrl(sessionId);
    logger.info(`创建异步反馈会话: ${sessionId}, 超时: ${timeoutSeconds}秒`);
    logger.mcpFeedbackPageCreated(sessionId, feedbackUrl, timeoutSeconds);

    // 浏览器打开失败不会阻塞 MCP 调用；失败状态仍可通过 wait/poll 读取。
    void this.openFeedbackPage(sessionId).catch(error => {
      logger.error('打开反馈页面失败:', error);
      const current = this.sessionStorage.getSession(sessionId);
      if (!current || current.status !== 'waiting') return;
      current.status = 'error';
      current.error = error instanceof Error ? error.message : '无法打开反馈页面';
      current.completedAt = Date.now();
      current.resultExpiresAt = current.completedAt + WebServer.RESULT_RETENTION_MS;
      this.clearSessionTimer(sessionId);
      this.sessionStorage.updateSession(sessionId, {
        status: current.status,
        error: current.error,
        completedAt: current.completedAt,
        resultExpiresAt: current.resultExpiresAt
      });
      this.sessionStorage.notifyWaiters(sessionId);
    });

    const snapshot = this.buildFeedbackSnapshot(sessionId, session);
    snapshot.feedback_url = feedbackUrl;
    return snapshot;
  }

  /**
   * 最多等待一小段时间，避免触发 Cursor 的长 MCP 请求超时。
   */
  async waitForFeedback(sessionId: string, waitSeconds = WebServer.MAX_WAIT_SECONDS): Promise<FeedbackSessionSnapshot> {
    const initial = this.pollFeedback(sessionId);
    if (initial.status !== 'waiting') return initial;

    const session = this.sessionStorage.getSession(sessionId);
    if (!session || session.status !== 'waiting') return this.pollFeedback(sessionId);

    const waitMs = Math.min(Math.max(1, Math.floor(waitSeconds)) * 1000, WebServer.MAX_WAIT_SECONDS * 1000);
    return new Promise<FeedbackSessionSnapshot>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (session.waiters) {
          const index = session.waiters.indexOf(finish);
          if (index >= 0) session.waiters.splice(index, 1);
        }
        resolve(this.pollFeedback(sessionId));
      };

      session.waiters ??= [];
      session.waiters.push(finish);

      // 避免注册等待者和状态变化之间的竞态。
      if (session.status !== 'waiting') {
        finish();
        return;
      }

      timer = setTimeout(finish, waitMs);
    });
  }

  /**
   * 立即读取会话状态；若刚好越过 deadline，则主动执行一次超时收口。
   */
  pollFeedback(sessionId: string): FeedbackSessionSnapshot {
    const session = this.sessionStorage.getSession(sessionId);
    if (!session) {
      return {
        session_id: sessionId,
        status: 'not_found',
        feedback: [],
        message: '会话不存在，可能已过期或服务已重启'
      };
    }

    if ((session.status ?? 'waiting') === 'waiting' && Date.now() >= session.startTime + session.timeout) {
      this.handleSessionTimeout(sessionId);
    }

    const current = this.sessionStorage.getSession(sessionId);
    return current
      ? this.buildFeedbackSnapshot(sessionId, current)
      : {
          session_id: sessionId,
          status: 'not_found',
          feedback: [],
          message: '会话不存在，可能已过期或服务已重启'
        };
  }

  /**
   * 旧版 API 兼容：保留直接等待的内部方法，新的 MCP 工具不调用它。
   */
  async collectFeedback(workSummary: string, timeoutSeconds: number): Promise<FeedbackData[]> {
    if (!this.isServerRunning) {
      await this.start();
    }

    const sessionId = this.generateSessionId();
    const now = Date.now();
    const timeoutMs = Math.max(10, timeoutSeconds) * 1000;
    return new Promise((resolve, reject) => {
      const session: SessionData = {
        workSummary,
        feedback: [],
        startTime: now,
        timeout: timeoutMs,
        status: 'waiting',
        resolve,
        reject
      };
      this.sessionStorage.createSession(sessionId, session);
      this.armSessionTimer(sessionId, timeoutMs);
      const feedbackUrl = this.generateFeedbackUrl(sessionId);
      logger.info(`创建旧版直接等待会话: ${sessionId}, 超时: ${timeoutSeconds}秒`);
      logger.mcpFeedbackPageCreated(sessionId, feedbackUrl, timeoutSeconds);
      void this.openFeedbackPage(sessionId).catch(error => {
        logger.error('打开反馈页面失败:', error);
        this.clearSessionTimer(sessionId);
        this.sessionStorage.deleteSession(sessionId);
        reject(error);
      });
    });
  }

  private buildFeedbackSnapshot(sessionId: string, session: SessionData): FeedbackSessionSnapshot {
    const status = session.status ?? 'waiting';
    const deadline = session.startTime + session.timeout;
    const remaining = status === 'waiting' ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
    const snapshot: FeedbackSessionSnapshot = {
      session_id: sessionId,
      status,
      work_summary: session.workSummary,
      feedback: session.feedback || [],
      created_at: session.startTime,
      deadline,
      remaining_seconds: remaining
    };
    if (session.error) snapshot.message = session.error;
    return snapshot;
  }

  /**
   * 生成反馈页面URL
   */
  private generateFeedbackUrl(sessionId: string): string {
    // 如果启用了固定URL模式，返回根路径
    if (this.config.useFixedUrl) {
      // 固定页面地址仍需携带会话参数，页面才能绑定正确的反馈会话。
      const separator = this.config.serverBaseUrl?.includes('?') ? '&' : '?';
      if (this.config.serverBaseUrl) {
        return `${this.config.serverBaseUrl}${separator}mode=feedback&session=${sessionId}`;
      }
      const host = this.config.serverHost || 'localhost';
      return `http://${host}:${this.port}/?mode=feedback&session=${sessionId}`;
    }

    // 传统模式：包含会话ID参数
    if (this.config.serverBaseUrl) {
      return `${this.config.serverBaseUrl}/?mode=feedback&session=${sessionId}`;
    }
    const host = this.config.serverHost || 'localhost';
    return `http://${host}:${this.port}/?mode=feedback&session=${sessionId}`;
  }

  /**
   * 打开反馈页面
   */
  private async openFeedbackPage(sessionId: string): Promise<void> {
    const url = this.generateFeedbackUrl(sessionId);
    logger.info(`打开反馈页面: ${url}`);

    // 已有页面连着（Socket.IO 客户端在线）就不弹新标签，页面会自动拉到新会话
    const clients = this.io?.engine?.clientsCount ?? 0;
    if (clients > 0) {
      logger.info(`已有 ${clients} 个客户端连接，跳过自动打开浏览器`);
      return;
    }

    // Windows 服务（SYSTEM / Session 0）里 open() 弹出的浏览器用户桌面看不见：
    // 配置 MCP_BROWSER_OPEN_TASK 后，改为触发以登录用户身份注册的计划任务来开浏览器
    const taskName = process.env['MCP_BROWSER_OPEN_TASK'];
    if (taskName && process.platform === 'win32') {
      const { execFile } = await import('child_process');
      execFile('schtasks', ['/run', '/tn', taskName], (err) => {
        if (err) {
          logger.warn(`计划任务 ${taskName} 触发失败: ${err.message}，请手动访问 ${url}`);
        } else {
          logger.info(`已通过计划任务 ${taskName} 在用户会话打开浏览器`);
        }
      });
      return;
    }

    try {
      const open = await import('open');
      await open.default(url);
      logger.info('浏览器已打开反馈页面');
    } catch (error) {
      logger.warn('无法自动打开浏览器:', error);
      logger.info(`请手动打开浏览器访问: ${url}`);
    }
  }

  /**
   * 生成会话ID
   */
  private generateSessionId(): string {
    return `feedback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 启动Web服务器
   */
  async start(): Promise<void> {
    if (this.isServerRunning) {
      logger.warn('Web服务器已在运行中');
      return;
    }

    try {
      // 根据配置选择端口策略
      if (this.config.forcePort) {
        // 强制端口模式
        logger.info(`强制端口模式: 尝试使用端口 ${this.config.webPort}`);

        // 根据配置决定是否清理端口
        if (this.config.cleanupPortOnStart) {
          logger.info(`启动时端口清理已启用，清理端口 ${this.config.webPort}`);
          await this.portManager.cleanupPort(this.config.webPort);
        }

        this.port = await this.portManager.forcePort(
          this.config.webPort,
          this.config.killProcessOnPortConflict || false
        );
      } else {
        // 智能端口模式：使用新的冲突解决方案
        logger.info(`智能端口模式: 尝试使用端口 ${this.config.webPort}`);
        this.port = await this.portManager.resolvePortConflict(this.config.webPort);
      }

      // 启动服务器前再次确认端口可用
      const bindHost = this.config.serverHost;
      logger.info(`准备在 ${bindHost || '0.0.0.0'}:${this.port} 启动服务器...`);

      // 启动服务器（指定 MCP_SERVER_HOST 时仅 bind 该地址，未指定保持原行为 bind 0.0.0.0 向后兼容）
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server start timeout'));
        }, 10000);

        const onListen = (error?: Error) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
            return;
          }

          // 端口为 0 时由操作系统动态分配，必须以实际监听地址为准。
          const address = this.server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Server did not expose a bound port'));
            return;
          }
          this.port = address.port;
          resolve();
        };

        if (bindHost) {
          this.server.listen(this.port, bindHost, onListen);
        } else {
          this.server.listen(this.port, onListen);
        }
      });

      this.isServerRunning = true;

      // 根据配置显示不同的启动信息
      const serverUrl = `http://localhost:${this.port}`;

      if (this.config.forcePort) {
        logger.info(`Web服务器启动成功 (强制端口): ${serverUrl}`);
      } else {
        logger.info(`Web服务器启动成功: ${serverUrl}`);
      }

      if (this.config.useFixedUrl) {
        logger.info(`固定URL模式已启用，访问地址: ${serverUrl}`);
      }

      // 发送MCP日志通知，包含端口和URL信息
      logger.mcpServerStarted(this.port, serverUrl);

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
   * 优雅停止Web服务器
   */
  async gracefulStop(): Promise<void> {
    if (!this.isServerRunning) {
      return;
    }

    const currentPort = this.port;
    logger.info(`开始优雅停止Web服务器 (端口: ${currentPort})...`);

    try {
      // 1. 停止接受新连接
      if (this.server) {
        this.server.close();
      }

      // 2. 通知所有客户端即将关闭
      if (this.io) {
        this.io.emit('server_shutdown', {
          message: '服务器即将关闭',
          timestamp: new Date().toISOString()
        });

        // 等待客户端处理关闭通知
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // 3. 关闭所有Socket连接
      if (this.io) {
        this.io.close();
      }

      // 4. 清理会话数据
      this.sessionStorage.clear();
      this.sessionStorage.stopCleanupTimer();

      // 5. 等待所有异步操作完成
      await new Promise(resolve => setTimeout(resolve, 2000));

      this.isServerRunning = false;
      logger.info(`Web服务器已优雅停止 (端口: ${currentPort})`);

    } catch (error) {
      logger.error('优雅停止Web服务器时出错:', error);
      // 即使出错也要标记为已停止
      this.isServerRunning = false;
      throw error;
    }
  }

  /**
   * 停止Web服务器
   */
  async stop(): Promise<void> {
    if (!this.isServerRunning) {
      return;
    }

    const currentPort = this.port;
    logger.info(`正在停止Web服务器 (端口: ${currentPort})...`);

    try {
      // 清理所有活跃会话
      for (const t of this.sessionTimers.values()) clearTimeout(t);
      this.sessionTimers.clear();
      this.sessionStorage.clear();
      this.sessionStorage.stopCleanupTimer();

      // 关闭所有WebSocket连接
      this.io.disconnectSockets(true);

      // 关闭Socket.IO
      this.io.close();

      // 关闭HTTP服务器
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server close timeout'));
        }, 5000);

        this.server.close((error?: Error) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });

      this.isServerRunning = false;
      logger.info(`Web服务器已停止 (端口: ${currentPort})`);

      // 等待端口完全释放
      logger.info(`等待端口 ${currentPort} 完全释放...`);
      try {
        await this.portManager.waitForPortRelease(currentPort, 3000);
        logger.info(`端口 ${currentPort} 已完全释放`);
      } catch (error) {
        logger.warn(`端口 ${currentPort} 释放超时，但服务器已停止`);
      }

    } catch (error) {
      logger.error('停止Web服务器时出错:', error);
      throw error;
    }
  }

  /**
   * 检查服务器是否运行
   */
  isRunning(): boolean {
    return this.isServerRunning;
  }

  /**
   * 获取服务器端口
   */
  getPort(): number {
    return this.port;
  }
}
