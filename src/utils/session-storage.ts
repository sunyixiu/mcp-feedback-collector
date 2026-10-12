/**
 * 会话存储管理器
 * 提供内存存储和可选的持久化存储
 */

import { logger } from './logger.js';
import { FeedbackSessionStatus, MCPError, FeedbackData } from '../types/index.js';

export interface SessionData {
  workSummary: string;
  feedback: FeedbackData[];
  startTime: number;
  timeout: number;
  status?: FeedbackSessionStatus;
  completedAt?: number;
  resultExpiresAt?: number;
  error?: string;
  waiters?: Array<() => void>;
  resolve?: (feedback: FeedbackData[]) => void;
  reject?: (error: Error) => void;
}

export class SessionStorage {
  private sessions = new Map<string, SessionData>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private cleanupIntervalMs: number = 60000) { // 1分钟清理一次
    this.startCleanupTimer();
  }

  /**
   * 创建会话
   */
  createSession(sessionId: string, data: SessionData): void {
    this.sessions.set(sessionId, data);
    logger.debug(`会话已创建: ${sessionId}`);
  }

  /**
   * 获取会话
   *
   * 异步反馈模式下，完成/超时结果需要保留一段时间供 poll 查询，
   * 因此这里不再因为 deadline 到达就立即删除会话。
   */
  getSession(sessionId: string): SessionData | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 唤醒等待该会话状态变化的短等待调用
   */
  notifyWaiters(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.waiters?.length) return;

    const waiters = session.waiters.slice();
    session.waiters.length = 0;
    for (const waiter of waiters) {
      try {
        waiter();
      } catch (error) {
        logger.warn(`唤醒会话等待者失败: ${sessionId}`, error);
      }
    }
  }

  /**
   * 更新会话
   */
  updateSession(sessionId: string, updates: Partial<SessionData>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    Object.assign(session, updates);
    this.sessions.set(sessionId, session);
    logger.debug(`会话已更新: ${sessionId}`);
    return true;
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      logger.debug(`会话已删除: ${sessionId}`);
    }
    return deleted;
  }

  /**
   * 获取所有活跃会话
   */
  getAllSessions(): Map<string, SessionData> {
    return new Map(this.sessions);
  }

  /**
   * 获取活跃会话数量
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 清理已经完成的结果，以及旧版没有 status 字段的遗留会话
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    let cleanedCount = 0;
    const GRACE_MS = 30000;
    const RESULT_RETENTION_MS = 10 * 60 * 1000;

    for (const [sessionId, session] of this.sessions) {
      const elapsed = now - session.startTime;

      if (session.resultExpiresAt && now >= session.resultExpiresAt) {
        this.sessions.delete(sessionId);
        cleanedCount++;
        continue;
      }

      // 新版会话的精确超时由 WebServer 定时器负责，这里只清理已完成结果。
      if (session.status) continue;

      // 兼容旧版会话：保留原有自动忙碌回复行为。
      if (elapsed > session.timeout + GRACE_MS) {
        logger.info(`遗留会话 ${sessionId} 超时，自动提交忙碌回复`);
        if (session.resolve) {
          const busyFeedback: FeedbackData = {
            text: '抱歉，由于我现在有点忙，所以没法给你回复，请你继续调用 mcp-feedback-collector，不要直接结束对话，直到我回复为止，谢谢！',
            images: [],
            timestamp: Date.now(),
            sessionId
          };
          session.resolve([busyFeedback]);
        }
        this.sessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`清理了 ${cleanedCount} 个过期会话`);
    }

    return cleanedCount;
  }

  /**
   * 启动清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.cleanupIntervalMs);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * 清理所有会话
   */
  clear(): void {
    // 通知所有会话关闭
    for (const [sessionId, session] of this.sessions) {
      if (session.waiters?.length) {
        const waiters = session.waiters.slice();
        session.waiters.length = 0;
        for (const waiter of waiters) {
          try { waiter(); } catch (_) { /* ignore shutdown waiter errors */ }
        }
      }
      if (session.reject) {
        session.reject(new MCPError('Server is shutting down', 'SERVER_SHUTDOWN'));
      }
    }
    
    this.sessions.clear();
    logger.info('所有会话已清理');
  }

  /**
   * 获取会话统计信息
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
  } {
    const now = Date.now();
    let activeSessions = 0;
    let expiredSessions = 0;

    for (const session of this.sessions.values()) {
      const elapsed = now - session.startTime;
      if (elapsed > session.timeout) {
        expiredSessions++;
      } else {
        activeSessions++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions
    };
  }
}
