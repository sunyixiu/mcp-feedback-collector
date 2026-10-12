import { jest } from '@jest/globals';
import { createDefaultConfig } from '../config/index.js';
import { WebServer } from '../server/web-server.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('异步反馈会话', () => {
  let webServer: WebServer;

  beforeEach(async () => {
    const config = createDefaultConfig();
    config.webPort = 0;
    config.logLevel = 'error';
    webServer = new WebServer(config);
    // 测试不需要真实打开浏览器。
    (webServer as any).openFeedbackPage = async () => undefined;
    await webServer.start();
  });

  afterEach(async () => {
    await webServer.stop();
  });

  test('创建会话立即返回 waiting 句柄', async () => {
    const startedAt = Date.now();
    const snapshot = await webServer.createFeedbackSession('异步测试汇报', 300);

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(snapshot.session_id).toMatch(/^feedback_\d+_[a-z0-9]+$/);
    expect(snapshot.status).toBe('waiting');
    expect(snapshot.feedback_url).toContain('localhost:');
  });

  test('wait_feedback 在用户提交后被唤醒', async () => {
    const snapshot = await webServer.createFeedbackSession('等待唤醒测试', 300);
    const waitPromise = webServer.waitForFeedback(snapshot.session_id, 5);
    await wait(25);

    const socket = { emit: jest.fn() };
    await (webServer as any).handleFeedbackSubmission(socket, {
      text: '收到',
      images: [],
      timestamp: Date.now(),
      sessionId: snapshot.session_id
    });

    const result = await waitPromise;
    expect(result.status).toBe('completed');
    expect(result.feedback[0]?.text).toBe('收到');
  });

  test('poll_feedback 能将过期会话收口为 timed_out', async () => {
    const snapshot = await webServer.createFeedbackSession('超时测试', 300);
    const storage = (webServer as any).sessionStorage;
    const session = storage.getSession(snapshot.session_id);
    session.startTime = Date.now() - session.timeout - 1;

    const result = webServer.pollFeedback(snapshot.session_id);
    expect(result.status).toBe('timed_out');
    expect(result.feedback[0]?.text).toContain('用户暂时未回复');
  });
});
