#!/usr/bin/env node

/**
 * MCP Feedback Collector - CLI入口
 */

// ============================================================
// CRITICAL: stdio-bootstrap 必须是第一个 import，在所有库加载前锁 stdout
// ============================================================
import { STDIO_BOOTSTRAP_ACTIVE } from './utils/stdio-bootstrap.js';

import { program } from 'commander';
import fetch from 'node-fetch';
import { getConfig, displayConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { MCPServer } from './server/mcp-server.js';
import { MCPError } from './types/index.js';
import { VERSION } from './index.js';

// 在最开始检测MCP模式并设置日志级别
// 改进的MCP模式检测：检查多个条件
const isMCPMode = STDIO_BOOTSTRAP_ACTIVE ||
                  !process.stdin.isTTY ||
                  process.env['NODE_ENV'] === 'mcp' ||
                  process.argv.includes('--mcp-mode');

if (isMCPMode) {
  logger.disableColors();
  logger.setLevel('silent' as any);
}

/**
 * 显示欢迎信息
 */
function showWelcome(): void {
  console.log('MCP Feedback Collector v' + VERSION);
  console.log('基于Node.js的现代化反馈收集器\n');
}

/**
 * 启动MCP服务器
 */
async function startMCPServer(options: {
  port?: number;
  web?: boolean;
  config?: string;
  debug?: boolean;
}): Promise<void> {
  try {
    // 加载配置
    const config = getConfig();

    if (!isMCPMode) {
      // 交互模式：显示欢迎信息和设置日志级别
      showWelcome();
      logger.setLevel(config.logLevel as any);
    }

    // 应用命令行参数
    if (options.port) {
      config.webPort = options.port;
    }

    // 设置调试模式（仅在非MCP模式下）
    if (!isMCPMode && (options.debug || process.env['LOG_LEVEL'] === 'debug')) {
      config.logLevel = 'debug';

      // 启用文件日志记录
      logger.enableFileLogging();
      logger.setLevel('debug');
      logger.debug('🐛 调试模式已启用，日志将保存到文件');
    }
    
    // 显示配置信息
    if (logger.getLevel() === 'debug') {
      displayConfig(config);
      console.log('');
    }
    
    // 创建并启动MCP服务器
    const server = new MCPServer(config);
    
    if (options.web) {
      // 仅Web模式
      logger.info('启动Web模式...');
      await server.startWebOnly();
    } else {
      // 完整MCP模式
      logger.info('启动MCP服务器...');
      await server.start();
    }
    
    // 注意：优雅关闭处理已在WebServer中实现，这里不需要重复处理
    
  } catch (error) {
    if (error instanceof MCPError) {
      logger.error(`MCP错误 [${error.code}]: ${error.message}`);
      if (error.details) {
        logger.debug('错误详情:', error.details);
      }
    } else if (error instanceof Error) {
      logger.error('启动失败:', error.message);
      logger.debug('错误堆栈:', error.stack);
    } else {
      logger.error('未知错误:', error);
    }
    process.exit(1);
  }
}

/**
 * 显示健康检查信息
 */
async function healthCheck(): Promise<void> {
  try {
    const config = getConfig();
    console.log('配置验证通过');
    console.log(`API端点: ${config.apiBaseUrl}`);
    console.log(`API密钥: ${config.apiKey ? '已配置' : '未配置'}`);
    console.log(`Web端口: ${config.webPort}`);
    console.log(`超时时间: ${config.dialogTimeout}秒`);
    
    // TODO: 添加更多健康检查项
    // - 端口可用性检查
    // - API连接测试
    // - 依赖项检查
    
  } catch (error) {
    if (error instanceof MCPError) {
      console.error(`配置错误 [${error.code}]: ${error.message}`);
    } else {
      console.error('健康检查失败:', error);
    }
    process.exit(1);
  }
}

// 配置CLI命令
program
  .name('mcp-feedback-collector')
  .description('基于Node.js的MCP反馈收集器')
  .version(VERSION);

// 主命令 - 启动服务器
program
  .command('start', { isDefault: true })
  .description('启动MCP反馈收集器')
  .option('-p, --port <number>', '指定Web服务器端口', parseInt)
  .option('-w, --web', '仅启动Web模式（不启动MCP服务器）')
  .option('-c, --config <path>', '指定配置文件路径')
  .option('-d, --debug', '启用调试模式（显示详细的MCP通信日志）')
  .option('--mcp-mode', '强制启用MCP模式（用于调试）')
  .action(startMCPServer);

// 健康检查命令
program
  .command('health')
  .description('检查配置和系统状态')
  .action(healthCheck);

// 配置显示命令
program
  .command('config')
  .description('显示当前配置')
  .action(() => {
    try {
      const config = getConfig();
      displayConfig(config);
    } catch (error) {
      console.error('配置加载失败:', error);
      process.exit(1);
    }
  });

// 性能监控命令
program
  .command('metrics')
  .description('显示性能监控指标')
  .option('-f, --format <format>', '输出格式 (json|text)', 'text')
  .action(async (options) => {
    try {
      showWelcome();

      const config = getConfig();
      logger.setLevel('error'); // 减少日志输出

      logger.info('🔍 获取性能监控指标...');

      // 创建MCP服务器实例
      const server = new MCPServer(config);

      // 启动Web服务器
      await server.startWebOnly();

      // 等待服务器完全启动
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        const response = await fetch(`http://localhost:${server.getStatus().webPort}/api/metrics`);
        const metrics = await response.json();

        if (options.format === 'json') {
          console.log(JSON.stringify(metrics, null, 2));
        } else {
          const reportResponse = await fetch(`http://localhost:${server.getStatus().webPort}/api/performance-report`);
          const report = await reportResponse.text();
          console.log(report);
        }

      } catch (error) {
        logger.error('获取性能指标失败:', error);
      }

      await server.stop();

    } catch (error) {
      logger.error('性能监控失败:', error);
      process.exit(1);
    }
  });

// 测试MCP工具函数命令
program
  .command('test-feedback')
  .description('测试collect_feedback工具函数')
  .option('-m, --message <message>', '测试工作汇报内容', '这是一个测试工作汇报，用于验证collect_feedback功能是否正常工作。')
  .option('-t, --timeout <seconds>', '会话超时时间（秒）', '30')
  .action(async (options) => {
    try {
      showWelcome();

      const config = getConfig();
      logger.setLevel(config.logLevel as any);

      logger.info('开始测试collect_feedback工具函数...');

      // 创建MCP服务器实例
      const server = new MCPServer(config);

      // 启动Web服务器
      await server.startWebOnly();

      // 等待服务器完全启动
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 创建测试会话
      logger.info('创建测试会话...');

      const timeoutSeconds = parseInt(options.timeout) || 30;
      const testParams = {
        work_summary: options.message,
        timeout_seconds: timeoutSeconds
      };

      try {
        const response = await fetch(`http://localhost:${server.getStatus().webPort}/api/test-session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(testParams)
        });

        const result = await response.json() as any;

        if (result.success) {
          logger.info('测试会话创建成功');
          logger.info(`会话ID: ${result.session_id}`);
          logger.info(`反馈页面: ${result.feedback_url}`);

          // 自动打开浏览器
          try {
            const open = await import('open');
            await open.default(result.feedback_url);
            logger.info('浏览器已自动打开反馈页面');
          } catch (error) {
            logger.warn('无法自动打开浏览器，请手动访问上述URL');
          }

          logger.info('现在您可以在浏览器中测试完整的反馈流程');
          logger.info(`会话将在 ${timeoutSeconds} 秒后超时`);

        } else {
          logger.error('测试会话创建失败:', result.error);
        }
      } catch (error) {
        logger.error('创建测试会话时出错:', error);
      }

      // 保持进程运行
      process.stdin.resume();

    } catch (error) {
      logger.error('测试失败:', error);
      if (error instanceof Error) {
        logger.error('错误详情:', error.message);
        logger.error('错误堆栈:', error.stack);
      }
      process.exit(1);
    }
  });

// 解析命令行参数
program.parse();
