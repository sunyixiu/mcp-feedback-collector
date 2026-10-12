/**
 * MCP Feedback Collector - 前端应用脚本
 */

// 全局变量
let socket = null;
let currentTab = 'report';
let selectedImages = [];
let chatImages = [];
let isConnected = false;
let currentFeedbackSession = null;

// AI聊天相关变量
let chatConfig = null;
let chatHistory = [];
let currentAIMessage = null;
let currentAIContent = '';
let isApiCalling = false;

// 自动刷新相关变量
let autoRefreshInterval = null;
let autoRefreshCountdown = 10;  // 改为10秒
let autoRefreshTimer = null;
let lastWorkSummary = null;  // 记录上次的工作汇报内容

// 超时倒计时相关变量（仅作显示；权威计时与"用户在忙"自动代答已移到服务端，
// 不再受浏览器后台标签页对 setTimeout/setInterval 的节流影响）
let sessionDeadline = null;          // 服务端下发的绝对截止时间戳（ms）
let sessionTimeoutDuration = 300000; // 默认5分钟，将从服务器获取
let countdownIntervalId = null;      // 倒计时显示定时器

// 空闲保活相关变量
let lastActivityTime = Date.now();
let keepAliveCheckInterval = null;
const KEEP_ALIVE_IDLE_MS = 180000; // 3分钟无操作则发保活
const KEEP_ALIVE_CHECK_MS = 30000; // 每30秒检查一次

// ============================================================
// 📝 草稿历史（防丢）
// ------------------------------------------------------------
// 用户输入反馈时实时保存到 localStorage，最多保留 10 条。
// 提交成功 → 标记 sent；提交失败 / 超时 → 标记 failed；编辑中 → editing。
// 失败/超时后用户可以从左侧抽屉点回任一草稿恢复到输入框。
// ============================================================
const DRAFTS_KEY = 'mcp_feedback_drafts_v1';
const DRAFTS_MAX = 10;
const DRAFT_DEBOUNCE_MS = 300;
let _currentDraftId = null;          // 当前正在编辑的 draft id
let _draftSaveTimer = null;          // debounce 定时器

// ============================================================
// 🔔 新反馈到达提醒（铃声 + 浏览器通知 + 标题闪烁）
// ------------------------------------------------------------
// 服务端若无法弹出用户桌面的浏览器（例如作为后台服务运行），
// 用户可以常驻一个固定地址的标签页，例如：
//   http://127.0.0.1:18053/
// 新反馈 session 到来时，WebSocket 推 session_assigned，
// 这里就播放铃声 + 弹系统通知 + 闪烁标题。
// ============================================================
let _audioCtx = null;
let _titleFlashInterval = null;
let _originalTitle = null;
let _lastRingSessionId = null; // 同一个 session_id 不重复响铃
let _lastRingSummaryHash = null; // 同一段 work_summary 不重复响铃
let _backgroundRingInterval = null; // tab 在后台时循环提醒的 timer
const NOTIFY_SOUND_KEY = 'mcp_notify_sound_enabled';
const BACKGROUND_RING_INTERVAL_MS = 25000; // 后台 tab 每 25 秒再响一次

function _hashSummary(s) {
    if (!s) return '';
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return String(h) + ':' + s.length;
}

function _maybeRing(sessionId, summary) {
    // 去重：同一会话 + 同一内容只响一次
    const h = _hashSummary(summary || '');
    if (sessionId && sessionId === _lastRingSessionId && h === _lastRingSummaryHash) return;
    _lastRingSessionId = sessionId;
    _lastRingSummaryHash = h;
    notifyNewFeedback(summary);
    startBackgroundRingLoop(summary);
}

// 如果 tab 当前在后台，持续循环响铃提醒；用户切回前台 / 提交反馈 / 新 session 来了就停
function startBackgroundRingLoop(summary) {
    stopBackgroundRingLoop();
    if (!document.hidden) return; // 前台直接不启动循环
    const snippet = (summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    _backgroundRingInterval = setInterval(() => {
        if (!document.hidden) { stopBackgroundRingLoop(); return; }
        if (!isNotifySoundEnabled()) return;
        _playBeep(880, 0.15, 0.00);
        _playBeep(1320, 0.15, 0.18);
        showSystemNotification('🔔 MCP 待处理反馈', snippet || '请回到页面查看并回复');
    }, BACKGROUND_RING_INTERVAL_MS);
}

function stopBackgroundRingLoop() {
    if (_backgroundRingInterval) {
        clearInterval(_backgroundRingInterval);
        _backgroundRingInterval = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stopBackgroundRingLoop();
});

function isNotifySoundEnabled() {
    try {
        const v = localStorage.getItem(NOTIFY_SOUND_KEY);
        return v === null ? true : v === '1';
    } catch (e) { return true; }
}

function setNotifySoundEnabled(enabled) {
    try { localStorage.setItem(NOTIFY_SOUND_KEY, enabled ? '1' : '0'); } catch (e) {}
}

function _playBeep(freq, duration, delay) {
    try {
        if (!_audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            _audioCtx = new AC();
        }
        if (_audioCtx.state === 'suspended') _audioCtx.resume();
        const ctx = _audioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t0 = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0.001, t0);
        gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
        osc.start(t0);
        osc.stop(t0 + duration + 0.02);
    } catch (e) {
        console.warn('beep失败（浏览器未交互过？）:', e);
    }
}

function flashTitle(altTitle) {
    if (_originalTitle === null) _originalTitle = document.title;
    if (_titleFlashInterval) clearInterval(_titleFlashInterval);
    let toggle = false;
    _titleFlashInterval = setInterval(() => {
        document.title = toggle ? _originalTitle : altTitle;
        toggle = !toggle;
    }, 800);
    const stopFlash = () => {
        if (!_titleFlashInterval) return;
        clearInterval(_titleFlashInterval);
        _titleFlashInterval = null;
        document.title = _originalTitle;
    };
    const onFocus = () => stopFlash();
    const onVisible = () => { if (!document.hidden) stopFlash(); };
    window.addEventListener('focus', onFocus, { once: true });
    document.addEventListener('visibilitychange', onVisible, { once: true });
}

function requestNotificationPermissionOnce() {
    try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    } catch (e) {}
}

function showSystemNotification(title, body) {
    try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission !== 'granted') return;
        const n = new Notification(title, {
            body: body || '',
            icon: '/favicon.ico',
            requireInteraction: false,
            silent: false,
        });
        n.onclick = () => { window.focus(); n.close(); };
        setTimeout(() => { try { n.close(); } catch (_) {} }, 8000);
    } catch (e) { console.warn('system notification failed:', e); }
}

function notifyNewFeedback(summary) {
    console.log('🔔 notifyNewFeedback 触发, 长度=', (summary || '').length);
    if (!isNotifySoundEnabled()) {
        console.log('🔕 铃声开关关闭，跳过');
        return;
    }
    // 三连铃
    _playBeep(880, 0.18, 0.00);
    _playBeep(1320, 0.18, 0.22);
    _playBeep(880, 0.30, 0.45);
    // 标题闪烁
    flashTitle('🔔 新反馈！');
    // 系统通知
    const snippet = (summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    showSystemNotification('🔔 MCP 新反馈请求', snippet || '请到浏览器查看并回复');
}

// 🧪 全局调试入口：在控制台敲 __mcpTestBell() 立刻测试铃声/通知
window.__mcpTestBell = function() {
    console.log('[TEST] AudioContext 状态=', _audioCtx ? _audioCtx.state : '(not created)');
    notifyNewFeedback('这是一条测试反馈，用于验证铃声与通知是否正常。');
};

// 获取API配置
async function loadChatConfig() {
    try {
        const response = await fetch('/api/config');
        if (response.ok) {
            chatConfig = await response.json();
            console.log('聊天配置加载成功:', chatConfig);

            // 检查是否需要显示API提示
            if (!chatConfig.api_key) {
                const apiHint = document.getElementById('api-hint');
                if (apiHint) {
                    apiHint.style.display = 'block';
                }
            }

            return true;
        } else {
            console.error('获取配置失败:', response.status);
            return false;
        }
    } catch (error) {
        console.error('加载配置时出错:', error);
        return false;
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', function() {
    // 加载聊天配置
    loadChatConfig();

    // 获取并显示版本信息
    fetchVersionInfo();

    initializeSocket();

    // 🔔 请求系统通知权限（延迟一下避免初次访问就弹）
    setTimeout(requestNotificationPermissionOnce, 2000);

    // 🔔 解锁 AudioContext：浏览器要求必须有用户手势才能播声音
    const _unlockAudio = () => {
        try {
            if (!_audioCtx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (AC) _audioCtx = new AC();
            }
            if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
        } catch (e) {}
    };
    ['click', 'keydown', 'touchstart'].forEach(evt =>
        window.addEventListener(evt, _unlockAudio, { once: true, passive: true })
    );

    // 检查URL参数
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    const session = urlParams.get('session');

    console.log('URL参数:', { mode, session });

    if (mode === 'feedback' && session) {
        // 传统反馈模式，设置会话ID并获取工作汇报
        currentFeedbackSession = session;
        console.log('传统模式 - 设置反馈会话ID:', session);

        // 等待WebSocket连接建立后获取工作汇报
        setTimeout(() => {
            if (isConnected && socket) {
                console.log('请求工作汇报数据...');
                socket.emit('get_work_summary', { feedback_session_id: session });
            } else {
                console.log('WebSocket未连接，稍后重试...');
                setTimeout(() => {
                    if (isConnected && socket) {
                        socket.emit('get_work_summary', { feedback_session_id: session });
                    }
                }, 1000);
            }
        }, 500);

        // 显示反馈标签页
        showTab('feedback');
    } else {
        // 固定URL模式或默认模式
        console.log('固定URL模式 - 等待会话分配');

        // 等待WebSocket连接建立后请求会话分配
        setTimeout(() => {
            if (isConnected && socket) {
                console.log('请求会话分配...');
                socket.emit('request_session');
            } else {
                console.log('WebSocket未连接，稍后重试...');
                setTimeout(() => {
                    if (isConnected && socket) {
                        socket.emit('request_session');
                    }
                }, 1000);
            }
        }, 500);

        // 默认显示工作汇报标签页（因为HTML中默认是active的）
        showTab('feedback');
    }

    // 默认启动自动刷新
    setTimeout(() => {
        startAutoRefresh();
    }, 1000); // 延迟1秒启动，确保页面完全加载

    // 启动空闲保活机制
    startKeepAliveMonitor();

    // 反馈输入框增强：Enter 提交（Shift+Enter 换行），Ctrl+V 粘贴图片
    bindFeedbackTextareaEnhancements();

    // 临时任务（pending instructions）UI：右上角浮动按钮 + 弹窗
    initPendingInstructionsUI();

    // 草稿历史抽屉（左侧）+ 实时存档防丢
    initDraftsUI();
});

// ============================================================
// 反馈输入框增强：
//   1) 回车键直接提交（Shift+Enter 仍是换行）
//   2) Ctrl/Cmd+V 直接粘贴图片到附件区
// ============================================================
function bindFeedbackTextareaEnhancements() {
    const textarea = document.getElementById('feedback-text');
    const form = document.getElementById('feedback-form');
    if (!textarea || !form) return;

    // 防重复绑定（开发热更新场景）
    if (textarea.dataset.enhBound === '1') return;
    textarea.dataset.enhBound = '1';

    // ---- 1) 回车提交 ----
    textarea.addEventListener('keydown', function(e) {
        // 中文/日文等输入法 composition 进行中时不要拦截
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            // 使用 requestSubmit 走原生 submit 事件流，与原 form 提交逻辑一致
            if (typeof form.requestSubmit === 'function') {
                form.requestSubmit();
            } else {
                form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            }
        }
    });

    // ---- 2) 粘贴图片 ----
    textarea.addEventListener('paste', function(e) {
        const cd = e.clipboardData || window.clipboardData;
        if (!cd || !cd.items) return;
        let imageHandled = false;
        for (const item of cd.items) {
            if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
                const blob = item.getAsFile();
                if (blob) {
                    const ext = (blob.type.split('/')[1] || 'png').replace('+xml', '');
                    const file = new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: blob.type });
                    addImage(file);
                    imageHandled = true;
                }
            }
        }
        if (imageHandled) {
            // 阻止把二进制 / 文件名字符串粘到 textarea 里
            e.preventDefault();
            try { showStatusMessage('success', '已粘贴图片到附件'); } catch (_) {}
        }
        // 没图片就走默认行为：正常粘贴文本
    });

    // placeholder 提示也更新一下，告诉用户支持快捷键
    if (!textarea.placeholder || textarea.placeholder.indexOf('Enter') === -1) {
        textarea.placeholder = (textarea.placeholder || '') +
            '（Enter 发送，Shift+Enter 换行，Ctrl+V 粘贴图片）';
    }
}

// 初始化WebSocket连接
function initializeSocket() {
    console.log('初始化Socket.IO连接...');

    socket = io({
        transports: ['websocket', 'polling'],
        timeout: 5000,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });

    socket.on('connect', function() {
        isConnected = true;
        updateConnectionStatus('connected', '已连接');
        console.log('WebSocket连接成功, ID:', socket.id);
    });

    socket.on('disconnect', function(reason) {
        isConnected = false;
        updateConnectionStatus('disconnected', '连接断开');
        console.log('WebSocket连接断开, 原因:', reason);
    });

    socket.on('connect_error', function(error) {
        isConnected = false;
        updateConnectionStatus('disconnected', '连接失败');
        console.error('WebSocket连接错误:', error);
        showStatusMessage('error', '连接服务器失败，请检查网络或刷新页面重试');
    });

    socket.on('feedback_session_started', function(data) {
        console.log('反馈会话已开始:', data);
    });

    socket.on('feedback_submitted', function(data) {
        // 草稿标 sent
        document.dispatchEvent(new CustomEvent('mcp:feedback-sent'));

        clearFeedbackForm();

        // 重新启用提交按钮
        const submitBtn = document.getElementById('submit-feedback-btn');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '提交反馈';

        // 停止后台循环铃声（提交完就不再打扰）
        stopBackgroundRingLoop();

        // 清理所有之前的状态消息（包括"已获取最新工作汇报"提示）
        clearAllStatusMessages();

        // 根据用户选择决定后续操作
        if (data.shouldCloseAfterSubmit) {
            // 用户选择提交并关闭页面
            showStatusMessage('success', '✅ 反馈提交成功！感谢您的宝贵意见。页面将在3秒后自动关闭。');
            console.log('反馈提交成功，3秒后关闭页面');

            // 3秒倒计时后关闭页面
            let countdown = 3;
            const countdownInterval = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    showStatusMessage('success', `✅ 反馈提交成功！感谢您的宝贵意见。页面将在${countdown}秒后自动关闭。`);
                } else {
                    clearInterval(countdownInterval);
                    window.close();
                }
            }, 1000);
        } else {
            // 用户选择提交但保持页面打开
            showStatusMessage('success', '✅ 反馈提交成功！感谢您的宝贵意见。页面将保持打开状态，您可以继续使用。');
            console.log('反馈提交成功，页面保持打开状态');
        }
    });

    socket.on('feedback_error', function(data) {
        // 草稿标 failed（用户的输入仍可在抽屉中找回）
        document.dispatchEvent(new CustomEvent('mcp:feedback-failed', { detail: { error: data?.error } }));

        showStatusMessage('error', data.error);
        // 提交按钮恢复，让用户可以再次提交（或修改后重提）
        const submitBtn = document.getElementById('submit-feedback-btn');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '提交反馈';
        }
    });

    socket.on('work_summary_data', function(data) {
        console.log('收到工作汇报数据:', data);
        if (data.work_summary) {
            displayWorkSummary(data.work_summary);
            // 记录初始工作汇报内容
            lastWorkSummary = data.work_summary;
            // 切换到反馈标签页
            showTab('feedback');
            // 🔔 新反馈提醒（去重）
            _maybeRing(data.session_id || currentFeedbackSession, data.work_summary);
        }
    });

    // 处理会话分配响应
    socket.on('session_assigned', function(data) {
        console.log('收到会话分配:', data);
        if (data.session_id) {
            currentFeedbackSession = data.session_id;
            console.log('固定URL模式 - 分配的会话ID:', data.session_id);
            console.log('接收到的超时时间:', data.timeout, '默认超时时间:', sessionTimeoutDuration);

            // 🔔 新反馈提醒（去重）
            _maybeRing(data.session_id, data.work_summary);

            // 启动倒计时显示（服务端为权威计时，前端只展示）
            const deadline = data.deadline || (Date.now() + (data.timeout || sessionTimeoutDuration));
            console.log('服务端截止时间:', new Date(deadline).toLocaleTimeString());
            startSessionCountdown(deadline);

            // 如果有工作汇报，显示它
            if (data.work_summary) {
                displayWorkSummary(data.work_summary);
                lastWorkSummary = data.work_summary;
                showTab('feedback');
                // 注意：原本这里在「页面已有旧内容 + 新内容不同」时会强制 reload，
                // 但 session_assigned 本身就会带着新 work_summary 进来，
                // 直接 displayWorkSummary 已经更新内容；reload 反而触发整个流程再走一遍。
                // 已移除 reload。
            }
        }
    });

    // 处理保活确认
    socket.on('keep_alive_ack', function(data) {
        if (data.success) {
            console.log('保活成功，会话超时已重置');
            // 用服务端下发的新截止时间重置倒计时显示
            const deadline = data.deadline || (Date.now() + sessionTimeoutDuration);
            startSessionCountdown(deadline);
        } else {
            console.warn('保活失败:', data.message);
        }
    });

    // 服务端权威超时通知（自动代答/熔断已在服务端完成，这里只做提示）
    socket.on('session_timed_out', function(data) {
        console.log('服务端会话超时通知:', data);
        if (data.session_id && data.session_id === currentFeedbackSession) {
            currentFeedbackSession = null;
        }
        clearSessionTimeout();
        clearAllStatusMessages();
        if (data.fused) {
            showStatusMessage('error', `🔌 连续超时 ${data.max} 次，服务端已熔断：通知 AI 终止会话。`, false);
        } else {
            showStatusMessage('info', `⏰ 会话超时 (${data.count}/${data.max})，服务端已自动代答"用户在忙"，AI 会重新调用 feedback。`, true);
        }
        try {
            _playBeep(660, 0.25, 0.00);
            _playBeep(990, 0.25, 0.30);
            flashTitle(data.fused ? '🔌 会话已熔断' : '⏰ 会话已超时');
            showSystemNotification(
                data.fused ? '🔌 MCP 会话熔断' : '⏰ MCP 会话超时',
                data.fused
                    ? `连续 ${data.max} 次无响应，已通知 AI 终止会话。`
                    : '服务端已代答"用户在忙"，AI 会重新调用 feedback 工具，请回来跟进。'
            );
        } catch (_) {}
    });

    // 处理无活跃会话的情况
    socket.on('no_active_session', function(data) {
        console.log('无活跃会话:', data);
        // 保持在聊天标签页，用户可以正常使用AI对话功能
    });

    // 处理最新工作汇报响应
    socket.on('latest_summary_response', function(data) {
        console.log('收到最新工作汇报响应:', data);

        if (data.success && data.work_summary) {
            // 检查内容是否与上次不同
            if (lastWorkSummary !== data.work_summary) {
                // 显示最新的工作汇报
                displayWorkSummary(data.work_summary);
                // 更新记录的内容
                lastWorkSummary = data.work_summary;
                // 切换 session（新会话 ID 进来）→ 同步更新 currentFeedbackSession
                // 这样后续 submit_feedback 不会用旧 sessionId
                if (data.session_id && data.session_id !== currentFeedbackSession) {
                    console.log(`session 切换: ${currentFeedbackSession} → ${data.session_id}`);
                    currentFeedbackSession = data.session_id;
                    // 重置倒计时显示（优先用服务端下发的截止时间）
                    startSessionCountdown(data.deadline || (Date.now() + sessionTimeoutDuration));
                }
                // 🔔 新反馈提醒（去重）
                _maybeRing(data.session_id || currentFeedbackSession, data.work_summary);
                // 恢复按钮文字
                const refreshText = document.getElementById('refresh-text');
                if (refreshText) {
                    refreshText.textContent = '刷新最新汇报';
                }
                showRefreshStatus('success', '✅ 已获取最新工作汇报');
                // 注意：原本这里有 setTimeout reload 页面的逻辑
                // 移除原因：reload 后 request_session 会再次触发 session_assigned + displayWorkSummary + _maybeRing
                // 造成「同一个 work_summary 推两遍」+ 重复响铃。
                // 现在 currentFeedbackSession 已就地更新，不需要 reload。
            } else {
                // 内容相同，显示无变化状态
                showRefreshStatus('success', '内容无变化');
                console.log('工作汇报内容未变化，跳过提示');
            }
        } else {
            // 没有找到最新的工作汇报
            showRefreshStatus('error', data.message || '暂无最新工作汇报');
        }
    });
}

// 更新连接状态
function updateConnectionStatus(status, text) {
    const statusEl = document.getElementById('connection-status');
    statusEl.className = `connection-status ${status}`;
    statusEl.textContent = text;
}

// 显示状态消息
function showStatusMessage(type, message, autoRemove = true) {
    const container = document.getElementById('status-messages');
    const messageEl = document.createElement('div');
    messageEl.className = `status-message ${type}`;
    messageEl.textContent = message;

    container.appendChild(messageEl);

    // 根据类型和参数决定自动移除时间
    if (autoRemove) {
        let removeTime = 3000; // 默认3秒
        if (type === 'success') {
            removeTime = 2000; // 成功消息2秒后移除
        }

        setTimeout(() => {
            if (messageEl.parentNode) {
                messageEl.parentNode.removeChild(messageEl);
            }
        }, removeTime);
    }

    // 返回消息元素，以便外部可以更新内容
    return messageEl;
}

// 清理所有状态消息
function clearAllStatusMessages() {
    const container = document.getElementById('status-messages');
    if (container) {
        container.innerHTML = '';
    }
}

// 显示指定标签页
function showTab(tabName) {
    currentTab = tabName;

    // 更新标签状态
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    // 找到对应的标签按钮并激活
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
        if ((tabName === 'feedback' && tab.textContent.includes('工作汇报')) ||
            (tabName === 'chat' && tab.textContent.includes('AI对话'))) {
            tab.classList.add('active');
        }
    });

    // 更新内容区域显示
    document.querySelectorAll('.content-area').forEach(area => {
        area.classList.remove('active');
    });

    // 根据标签名称显示对应内容
    const contentId = tabName === 'feedback' ? 'report-content' : 'chat-content';
    const contentElement = document.getElementById(contentId);
    if (contentElement) {
        contentElement.classList.add('active');
    }
}

// 切换标签（保持向后兼容）
function switchTab(tabName) {
    // 映射标签名称
    const tabMapping = {
        'report': 'feedback',
        'feedback': 'feedback',
        'chat': 'chat'
    };

    const newTabName = tabMapping[tabName] || tabName;
    showTab(newTabName);
}

// 反馈表单相关功能
function selectImages() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;

    input.onchange = function(e) {
        const files = Array.from(e.target.files);
        files.forEach(file => {
            if (file.type.startsWith('image/')) {
                addImage(file);
            }
        });
    };

    input.click();
}

function pasteImages() {
    navigator.clipboard.read().then(items => {
        for (const item of items) {
            for (const type of item.types) {
                if (type.startsWith('image/')) {
                    item.getType(type).then(blob => {
                        const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
                        addImage(file);
                    });
                }
            }
        }
    }).catch(err => {
        console.log('粘贴失败:', err);
        showStatusMessage('error', '粘贴图片失败，请尝试选择文件方式');
    });
}

// 客户端压缩：大图先缩放到最大边 MAX_DIM，再以 JPEG 重编码，避免 websocket 传输过大导致断连。
function compressImageFile(file, maxDim = 1600, quality = 0.85) {
    return new Promise((resolve) => {
        // 小图（<300KB）直接原样返回，省去解码开销。
        if (!file || !file.type || !file.type.startsWith('image/') || file.size <= 300 * 1024) {
            const r = new FileReader();
            r.onload = (e) => resolve({ data: e.target.result, size: file.size, type: file.type });
            r.onerror = () => resolve(null);
            r.readAsDataURL(file);
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                const scale = Math.min(1, maxDim / Math.max(width, height));
                width = Math.round(width * scale);
                height = Math.round(height * scale);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    const out = canvas.toDataURL('image/jpeg', quality);
                    const outSize = Math.round((out.length - out.indexOf(',') - 1) * 0.75);
                    // 压缩没变小就用原图（例如本就很小的 PNG）
                    if (outSize >= file.size) {
                        resolve({ data: e.target.result, size: file.size, type: file.type });
                    } else {
                        resolve({ data: out, size: outSize, type: 'image/jpeg' });
                    }
                } catch (err) {
                    resolve({ data: e.target.result, size: file.size, type: file.type });
                }
            };
            img.onerror = () => resolve({ data: e.target.result, size: file.size, type: file.type });
            img.src = e.target.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

function addImage(file) {
    compressImageFile(file).then((res) => {
        if (!res) return;
        const imageData = {
            file: file,
            data: res.data,
            name: file.name,
            size: res.size,
            type: res.type,
            id: Date.now() + Math.random()
        };

        selectedImages.push(imageData);
        updateImagePreviews();
    });
}

function updateImagePreviews() {
    const container = document.getElementById('image-previews');
    const convertBtn = document.getElementById('convert-images-btn');

    container.innerHTML = '';

    selectedImages.forEach((image, index) => {
        const previewDiv = document.createElement('div');
        previewDiv.className = 'image-preview';
        previewDiv.innerHTML = `
            <img src="${image.data}" alt="${image.name}" class="preview-img">
            <button type="button" class="remove-btn" onclick="removeImage(${index})">×</button>
        `;
        container.appendChild(previewDiv);
    });

    // 显示或隐藏图片转文本按钮
    if (selectedImages.length > 0) {
        convertBtn.style.display = 'inline-block';
    } else {
        convertBtn.style.display = 'none';
        // 隐藏图片描述区域
        const descriptionsArea = document.getElementById('image-descriptions');
        if (descriptionsArea) {
            descriptionsArea.style.display = 'none';
        }
    }
}

function removeImage(index) {
    selectedImages.splice(index, 1);
    updateImagePreviews();
}

// 图片转文字功能
async function convertImagesToText() {
    const btn = document.getElementById('convert-images-btn');
    const descriptionsArea = document.getElementById('image-descriptions');
    const descriptionsContent = document.getElementById('descriptions-content');

    if (selectedImages.length === 0) {
        showStatusMessage('warning', '请先上传图片');
        return;
    }

    // 显示加载状态
    const originalText = btn.textContent;
    btn.textContent = '🔄 转换中...';
    btn.disabled = true;

    try {
        // 准备图片数据
        const images = selectedImages.map(img => ({
            name: img.name,
            type: img.type,
            data: img.data
        }));

        // 调用后端API转换图片
        const response = await fetch('/api/convert-images', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ images })
        });

        const result = await response.json();

        if (result.success && result.descriptions) {
            // 显示转换结果
            descriptionsContent.innerHTML = '';
            result.descriptions.forEach((desc, index) => {
                const descDiv = document.createElement('div');
                descDiv.className = 'description-item';
                descDiv.innerHTML = `
                    <div class="description-header">
                        <strong>图片 ${index + 1}: ${selectedImages[index].name}</strong>
                    </div>
                    <textarea class="description-text" rows="3" placeholder="图片描述...">${desc}</textarea>
                `;
                descriptionsContent.appendChild(descDiv);
            });

            descriptionsArea.style.display = 'block';
            showStatusMessage('success', '图片转换完成，您可以编辑描述内容');
        } else {
            showStatusMessage('error', '图片转换失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('图片转换出错:', error);
        showStatusMessage('error', '图片转换出错: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

function clearFeedbackForm() {
    document.getElementById('feedback-text').value = '';
    selectedImages = [];
    updateImagePreviews();

    // 清空图片描述区域
    const descriptionsArea = document.getElementById('image-descriptions');
    const descriptionsContent = document.getElementById('descriptions-content');
    if (descriptionsArea) {
        descriptionsArea.style.display = 'none';
    }
    if (descriptionsContent) {
        descriptionsContent.innerHTML = '';
    }
}

// 快捷语内容
const QUICK_PHRASE = `

---

Whenever you want to ask a question, use the MCP feedback tools.

Before completing a user request:
1. Call check_pending_instructions first and process every returned instruction in FIFO order.
2. Call collect_feedback once with work_summary. It returns a session_id immediately.
3. Call wait_feedback with that session_id for at most 45 seconds per call.
4. If the status is still waiting, call wait_feedback again later or use poll_feedback for an immediate check.
5. Stop only when the feedback session returns completed, timed_out, cancelled, or an unrecoverable error.

Do not call collect_feedback repeatedly for the same work summary while the previous session is still waiting.`;

// 提交反馈
document.getElementById('feedback-form').addEventListener('submit', function(e) {
    e.preventDefault();

    let feedbackText = document.getElementById('feedback-text').value.trim();

    // 检查是否需要附加快捷语
    const addQuickPhrase = document.getElementById('add-quick-phrase').checked;
    if (addQuickPhrase && feedbackText) {
        feedbackText += QUICK_PHRASE;
    }

    console.log('提交反馈:', {
        text: feedbackText,
        images: selectedImages.length,
        session: currentFeedbackSession,
        connected: isConnected
    });

    if (!feedbackText && selectedImages.length === 0) {
        showStatusMessage('error', '请输入反馈内容或选择图片');
        return;
    }

    if (!isConnected) {
        showStatusMessage('error', '连接已断开，请刷新页面重试');
        return;
    }

    // 检查会话ID
    if (!currentFeedbackSession) {
        showStatusMessage('error', '当前为演示模式，请通过MCP工具函数调用来创建正式的反馈会话');
        console.log('演示模式 - 反馈内容:', {
            text: feedbackText,
            images: selectedImages.length,
            timestamp: new Date().toLocaleString()
        });

        // 显示演示反馈
        showStatusMessage('info', '演示反馈已记录到控制台，请查看浏览器开发者工具');
        clearFeedbackForm();
        return;
    }

    // 显示提交确认对话框
    showSubmitConfirmDialog(feedbackText);
});

// 显示提交确认对话框
function showSubmitConfirmDialog(feedbackText) {
    // 防止重复显示对话框
    if (document.getElementById('submit-confirm-dialog')) {
        return;
    }

    // 创建对话框HTML
    const dialogHTML = `
        <div id="submit-confirm-dialog" class="dialog-overlay">
            <div class="dialog-content">
                <div class="dialog-header">
                    <h3>📤 提交反馈确认</h3>
                </div>
                <div class="dialog-body">
                    <p>请选择提交后的操作：</p>
                    <div class="dialog-options">
                        <button id="submit-and-close-btn" class="dialog-btn primary">
                            🚪 提交并关闭页面
                        </button>
                        <button id="submit-and-keep-btn" class="dialog-btn secondary">
                            📝 提交但保持页面打开
                        </button>
                    </div>
                </div>
                <div class="dialog-footer">
                    <button id="cancel-submit-btn" class="dialog-btn cancel">取消</button>
                </div>
            </div>
        </div>
    `;

    // 添加对话框到页面
    document.body.insertAdjacentHTML('beforeend', dialogHTML);

    // 绑定事件
    document.getElementById('submit-and-close-btn').onclick = () => {
        hideSubmitConfirmDialog();
        submitFeedback(feedbackText, true); // 提交并关闭
    };

    document.getElementById('submit-and-keep-btn').onclick = () => {
        hideSubmitConfirmDialog();
        submitFeedback(feedbackText, false); // 提交但保持打开
    };

    document.getElementById('cancel-submit-btn').onclick = () => {
        hideSubmitConfirmDialog();
    };

    // 点击背景关闭对话框
    document.getElementById('submit-confirm-dialog').onclick = (e) => {
        if (e.target.id === 'submit-confirm-dialog') {
            hideSubmitConfirmDialog();
        }
    };

    // 添加键盘支持 - ESC键关闭对话框
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            hideSubmitConfirmDialog();
            document.removeEventListener('keydown', handleKeydown);
        }
    };
    document.addEventListener('keydown', handleKeydown);

    // 自动聚焦到第一个按钮，提升键盘导航体验
    setTimeout(() => {
        const firstBtn = document.getElementById('submit-and-close-btn');
        if (firstBtn) {
            firstBtn.focus();
        }
    }, 100);
}

// 隐藏提交确认对话框
function hideSubmitConfirmDialog() {
    const dialog = document.getElementById('submit-confirm-dialog');
    if (dialog) {
        // 清理键盘事件监听器
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                hideSubmitConfirmDialog();
                document.removeEventListener('keydown', handleKeydown);
            }
        };
        document.removeEventListener('keydown', handleKeydown);

        dialog.remove();
    }
}

// 实际提交反馈的函数
function submitFeedback(feedbackText, shouldCloseAfterSubmit) {
    // 清除倒计时显示（服务端收到真实反馈后会重置熔断计数）
    clearSessionTimeout();

    // 禁用提交按钮
    const submitBtn = document.getElementById('submit-feedback-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '提交中...';
    }

    // 获取图片描述
    const imageDescriptions = [];
    const descriptionTextareas = document.querySelectorAll('.description-text');
    descriptionTextareas.forEach(textarea => {
        imageDescriptions.push(textarea.value || '');
    });

    // 发送反馈数据
    const feedbackData = {
        text: feedbackText,
        images: selectedImages.map(img => ({
            name: img.name,
            data: img.data,
            size: img.size,
            type: img.type
        })),
        imageDescriptions: imageDescriptions.length > 0 ? imageDescriptions : undefined, // 包含图片描述
        timestamp: Date.now(),
        sessionId: currentFeedbackSession,
        shouldCloseAfterSubmit: shouldCloseAfterSubmit // 添加关闭标志
    };

    console.log('发送反馈数据:', feedbackData);
    socket.emit('submit_feedback', feedbackData);

    // 5秒后重新启用按钮（防止卡住）
    setTimeout(() => {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '提交反馈';
        }
    }, 5000);
}



// 显示工作汇报内容
function displayWorkSummary(workSummary) {
    console.log('displayWorkSummary 被调用:', workSummary);

    if (!workSummary || workSummary.trim() === '') {
        console.log('工作汇报内容为空');
        return;
    }

    // 找到工作汇报内容区域
    const reportContent = document.getElementById('report-content');
    if (!reportContent) {
        console.error('找不到 report-content 元素');
        return;
    }

    // 隐藏默认消息
    const defaultMessage = document.getElementById('default-message');
    if (defaultMessage) {
        defaultMessage.style.display = 'none';
    }

    // 检查是否已经有AI工作汇报卡片
    const existingCard = reportContent.querySelector('.ai-work-report');
    if (existingCard) {
        existingCard.remove();
    }

    // 创建AI工作汇报卡片
    const aiReportCard = document.createElement('div');
    aiReportCard.className = 'report-card ai-work-report';
    aiReportCard.innerHTML = `
        <div class="card-header">
            <div class="card-title">
                <span>🤖</span>
                AI工作汇报
            </div>
            <div class="card-subtitle">刚刚完成</div>
        </div>
        <div class="card-body">
            <div class="work-summary-content">${workSummary.replace(/\n/g, '<br>')}</div>
        </div>
    `;

    // 插入到现有内容之前
    const firstCard = reportContent.querySelector('.report-card');
    if (firstCard) {
        reportContent.insertBefore(aiReportCard, firstCard);
    } else {
        reportContent.appendChild(aiReportCard);
    }

    console.log('AI工作汇报卡片已添加');

    // 添加样式（只添加一次）
    if (!document.querySelector('#work-summary-styles')) {
        const style = document.createElement('style');
        style.id = 'work-summary-styles';
        style.textContent = `
            .work-summary-content {
                color: #cccccc;
                line-height: 1.6;
                font-size: 13px;
                white-space: pre-wrap;
                word-wrap: break-word;
                background: #1e1e1e;
                padding: 12px;
                border-radius: 4px;
                border: 1px solid #3e3e42;
            }
            .ai-work-report {
                border-left: 3px solid #4ec9b0;
            }
        `;
        document.head.appendChild(style);
    }
}

// ==================== 工作汇报刷新功能 ====================

/**
 * 显示刷新状态
 */
function showRefreshStatus(type, message) {
    const statusText = document.getElementById('refresh-status-text');
    if (!statusText) return;

    statusText.className = `refresh-status-text ${type}`;
    statusText.textContent = message;

    // 如果是成功或错误状态，2秒后自动清空
    if (type === 'success' || type === 'error') {
        setTimeout(() => {
            statusText.textContent = '';
            statusText.className = 'refresh-status-text';
        }, 2000);
    }
}

/**
 * 隐藏刷新状态
 */
function hideRefreshStatus() {
    const statusText = document.getElementById('refresh-status-text');
    if (statusText) {
        statusText.textContent = '';
        statusText.className = 'refresh-status-text';
    }
}

/**
 * 手动刷新工作汇报
 */
function refreshWorkSummary() {
    console.log('手动刷新工作汇报');

    const refreshBtn = document.getElementById('refresh-report-btn');
    const refreshText = document.getElementById('refresh-text');

    if (!refreshBtn || !refreshText) {
        console.error('找不到刷新按钮元素');
        return;
    }

    if (isConnected && socket) {
        // 显示加载状态
        refreshText.textContent = '正在获取最新工作汇报...';
        showRefreshStatus('loading', '正在获取最新工作汇报...');

        // 请求最新的工作汇报
        socket.emit('request_latest_summary');

        // 5秒后恢复按钮文字（防止卡住）
        setTimeout(() => {
            refreshText.textContent = '刷新最新汇报';
            hideRefreshStatus();
        }, 5000);
    } else {
        // 连接断开时的处理
        showRefreshStatus('error', '连接已断开，无法刷新');
    }
}



/**
 * 开始自动刷新
 */
function startAutoRefresh() {
    console.log('开始自动刷新');

    // 清除现有的定时器
    stopAutoRefresh();

    // 重置倒计时
    autoRefreshCountdown = 10;
    updateAutoRefreshCountdown();

    // 设置倒计时定时器
    autoRefreshTimer = setInterval(() => {
        autoRefreshCountdown--;
        updateAutoRefreshCountdown();

        if (autoRefreshCountdown <= 0) {
            // 执行刷新
            refreshWorkSummary();
            // 重置倒计时
            autoRefreshCountdown = 10;
        }
    }, 1000);

    console.log('自动刷新已启用，每10秒刷新一次');
}

/**
 * 停止自动刷新
 */
function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }

    autoRefreshCountdown = 10;
    updateAutoRefreshCountdown();

    console.log('自动刷新已停止');
}

/**
 * 更新自动刷新倒计时显示
 */
function updateAutoRefreshCountdown() {
    const countdownEl = document.getElementById('auto-refresh-countdown');
    const statusText = document.getElementById('refresh-status-text');

    if (countdownEl) {
        countdownEl.textContent = autoRefreshCountdown;
    }

    if (statusText) {
        statusText.textContent = `下次自动刷新：${autoRefreshCountdown}秒后`;
        statusText.className = 'refresh-status-text';
    }
}

// ==================== AI聊天功能 ====================

// 聊天相关功能
function selectChatImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;

    input.onchange = function(e) {
        const files = Array.from(e.target.files);
        files.forEach(file => {
            if (file.type.startsWith('image/')) {
                addChatImage(file);
            }
        });
    };

    input.click();
}

function pasteChatImage() {
    navigator.clipboard.read().then(items => {
        for (const item of items) {
            for (const type of item.types) {
                if (type.startsWith('image/')) {
                    item.getType(type).then(blob => {
                        const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: blob.type });
                        addChatImage(file);
                    });
                }
            }
        }
    }).catch(err => {
        console.log('粘贴失败:', err);
        showStatusMessage('error', '粘贴图片失败，请尝试选择文件方式');
    });
}

function addChatImage(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const imageData = {
            file: file,
            data: e.target.result,
            name: file.name,
            id: Date.now() + Math.random()
        };
        chatImages.push(imageData);
        updateChatImagePreviews();
        showStatusMessage('info', `已添加图片: ${file.name}`);
    };
    reader.readAsDataURL(file);
}

function updateChatImagePreviews() {
    const container = document.getElementById('chat-image-previews-content');
    const previewArea = document.getElementById('chat-image-previews');

    if (!container || !previewArea) return;

    container.innerHTML = '';

    if (chatImages.length === 0) {
        previewArea.style.display = 'none';
        return;
    }

    previewArea.style.display = 'block';

    chatImages.forEach((image, index) => {
        const previewDiv = document.createElement('div');
        previewDiv.className = 'image-preview';
        previewDiv.innerHTML = `
            <img src="${image.data}" alt="${image.name}" class="preview-img">
            <button type="button" class="remove-btn" onclick="removeChatImage(${index})">×</button>
        `;
        container.appendChild(previewDiv);
    });
}

function removeChatImage(index) {
    chatImages.splice(index, 1);
    updateChatImagePreviews();
}

function handleChatKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
    }
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const messageText = input ? input.value.trim() : '';

    if (!messageText && chatImages.length === 0) {
        return;
    }

    // 检查配置
    if (!chatConfig || !chatConfig.api_key) {
        showStatusMessage('error', 'API配置未加载或API密钥未设置');
        return;
    }

    if (isApiCalling) {
        showStatusMessage('warning', '正在处理中，请稍候...');
        return;
    }

    // 添加用户消息到界面
    addMessageToChat('user', messageText, chatImages);

    // 清空输入
    if (input) input.value = '';
    const currentImages = chatImages.slice();
    chatImages = [];
    updateChatImagePreviews();

    // 禁用发送按钮
    const sendBtn = document.getElementById('send-chat-btn');
    sendBtn.disabled = true;
    isApiCalling = true;

    // 准备接收AI回复
    currentAIContent = '';
    currentAIMessage = addMessageToChat('ai', '', []);

    try {
        await callChatAPI(messageText, currentImages);
    } catch (error) {
        console.error('聊天API调用失败:', error);
        showStatusMessage('error', `聊天失败: ${error.message}`);
    } finally {
        // 重新启用发送按钮
        sendBtn.disabled = false;
        isApiCalling = false;
    }
}

// 直接调用聊天API
async function callChatAPI(messageText, images) {
    // 构建消息格式
    const userMessage = buildAPIMessage(messageText, images);

    // 添加到聊天历史
    chatHistory.push(userMessage);

    // 构建API请求
    const requestBody = {
        model: chatConfig.model,
        messages: chatHistory,
        stream: true,
        temperature: chatConfig.temperature || 0.7,
        max_tokens: chatConfig.max_tokens || 2000
    };

    console.log('发送API请求:', {
        url: `${chatConfig.api_base_url}/v1/chat/completions`,
        model: requestBody.model,
        messageCount: requestBody.messages.length
    });

    const response = await fetch(`${chatConfig.api_base_url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${chatConfig.api_key}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
    }

    // 处理流式响应
    await handleStreamResponse(response);
}

// 构建API消息格式
function buildAPIMessage(messageText, images) {
    if (!images || images.length === 0) {
        // 纯文本消息
        return { role: "user", content: messageText };
    } else {
        // 包含图片的消息
        const content = [];

        if (messageText) {
            content.push({ type: "text", text: messageText });
        }

        images.forEach(img => {
            let imageData = img.data;
            // 确保是完整的data URL格式
            if (!imageData.startsWith('data:image/')) {
                imageData = `data:image/png;base64,${imageData}`;
            }

            content.push({
                type: "image_url",
                image_url: { url: imageData }
            });
        });

        return { role: "user", content: content };
    }
}

// 处理流式响应
async function handleStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let aiResponseContent = '';

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.trim() === '') continue;

                if (line.startsWith('data: ')) {
                    const data = line.slice(6); // 移除 'data: ' 前缀

                    if (data === '[DONE]') {
                        // 流式响应结束
                        if (aiResponseContent) {
                            // 将AI回复添加到聊天历史
                            chatHistory.push({
                                role: "assistant",
                                content: aiResponseContent
                            });
                        }
                        console.log('AI回复完成，总长度:', aiResponseContent.length);
                        return;
                    }

                    try {
                        const jsonData = JSON.parse(data);
                        if (jsonData.choices && jsonData.choices[0]) {
                            const delta = jsonData.choices[0].delta;
                            if (delta && delta.content) {
                                aiResponseContent += delta.content;

                                // 更新界面显示
                                if (currentAIMessage) {
                                    currentAIMessage.innerHTML = aiResponseContent;

                                    // 滚动到底部
                                    const chatMessages = document.getElementById('chat-messages');
                                    chatMessages.scrollTop = chatMessages.scrollHeight;
                                }
                            }
                        }
                    } catch (e) {
                        // 忽略JSON解析错误
                        console.log('JSON解析错误:', e);
                    }
                }
            }
        }
    } catch (error) {
        console.error('处理流式响应时出错:', error);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

function addMessageToChat(sender, text, images) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return null;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;

    let imageHtml = '';
    if (images && images.length > 0) {
        imageHtml = images.map(img =>
            `<img src="${img.data}" style="max-width: 200px; max-height: 200px; border-radius: 4px; margin: 4px 0; display: block;">`
        ).join('');
    }

    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'message-bubble';
    bubbleDiv.innerHTML = `${imageHtml}${text}`;

    messageDiv.appendChild(bubbleDiv);
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return bubbleDiv; // 返回气泡元素，用于更新AI消息
}

function clearChat() {
    if (confirm('确定要清空所有聊天记录吗？')) {
        // 清空聊天历史
        chatHistory = [];

        // 清空界面显示
        clearChatMessages();

        showStatusMessage('info', '聊天记录已清空');
    }
}

function clearChatMessages() {
    const chatMessages = document.getElementById('chat-messages');
    // 保留欢迎消息和API提示
    const children = Array.from(chatMessages.children);
    children.forEach((child, index) => {
        if (index > 2) { // 保留前3个元素（时间、欢迎消息、API提示）
            child.remove();
        }
    });
}

// 获取版本信息
async function fetchVersionInfo() {
    try {
        const response = await fetch('/api/version');
        if (response.ok) {
            const data = await response.json();
            updateVersionDisplay(data.version);
        } else {
            console.log('无法获取版本信息，使用默认版本');
        }
    } catch (error) {
        console.log('获取版本信息失败:', error);
    }
}

// 更新版本显示
function updateVersionDisplay(version) {
    const versionElement = document.getElementById('version-number');
    if (versionElement && version) {
        versionElement.textContent = version;
    }
}

// ==================== 超时倒计时（仅显示） ====================
// 权威计时在服务端：到点由服务端自动代答"用户在忙"并做熔断计数。
// 前端只根据服务端下发的绝对截止时间戳渲染倒计时，即使标签页被节流，
// 恢复前台后一算 deadline - now 也立即显示正确剩余时间。

/**
 * 启动会话倒计时显示
 * @param {number} deadline 服务端下发的绝对截止时间戳（毫秒）
 */
function startSessionCountdown(deadline) {
    clearSessionTimeout();
    sessionDeadline = deadline;
    console.log(`启动倒计时显示，截止: ${new Date(deadline).toLocaleTimeString()}`);
    startCountdownDisplay();
}

/**
 * 清除会话倒计时显示
 */
function clearSessionTimeout() {
    sessionDeadline = null;
    if (countdownIntervalId) {
        clearInterval(countdownIntervalId);
        countdownIntervalId = null;
    }
    hideCountdownDisplay();
}

/**
 * 获取剩余时间（秒），基于服务端截止时间戳
 */
function getRemainingTime() {
    if (!sessionDeadline) {
        return 0;
    }
    return Math.max(0, Math.ceil((sessionDeadline - Date.now()) / 1000));
}

// ==================== 倒计时显示功能 ====================

/**
 * 启动倒计时显示
 */
function startCountdownDisplay() {
    const countdownEl = document.getElementById('timeout-countdown');
    if (!countdownEl) return;

    // 显示倒计时元素
    countdownEl.style.display = 'block';

    // 启动倒计时更新定时器
    countdownIntervalId = setInterval(() => {
        updateCountdownDisplay();
    }, 1000);

    // 立即更新一次
    updateCountdownDisplay();
}

/**
 * 更新倒计时显示
 */
function updateCountdownDisplay() {
    const countdownEl = document.getElementById('timeout-countdown');
    if (!countdownEl) return;

    const remainingTime = getRemainingTime();

    if (remainingTime <= 0) {
        hideCountdownDisplay();
        return;
    }

    // 格式化时间显示
    const minutes = Math.floor(remainingTime / 60);
    const seconds = remainingTime % 60;
    const timeText = minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}`;

    // 根据剩余时间设置不同的样式和文本
    if (remainingTime <= 10) {
        countdownEl.className = 'timeout-countdown critical';
        countdownEl.textContent = `⚠️ 会话将在 ${timeText} 秒后超时`;
    } else if (remainingTime <= 30) {
        countdownEl.className = 'timeout-countdown warning';
        countdownEl.textContent = `⏰ 会话将在 ${timeText} 秒后超时`;
    } else {
        countdownEl.className = 'timeout-countdown';
        countdownEl.textContent = `⏱️ 会话剩余时间: ${timeText}`;
    }
}

/**
 * 隐藏倒计时显示
 */
function hideCountdownDisplay() {
    const countdownEl = document.getElementById('timeout-countdown');
    if (countdownEl) {
        countdownEl.style.display = 'none';
    }
}

// ==================== 空闲保活机制 ====================

/**
 * 记录用户活动（输入、点击、鼠标移动等）
 */
function recordUserActivity() {
    lastActivityTime = Date.now();
}

/**
 * 启动空闲保活监控
 */
function startKeepAliveMonitor() {
    // 监听用户活动事件
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
        document.addEventListener(evt, recordUserActivity, { passive: true });
    });

    // 特别监听反馈输入框
    const feedbackInput = document.getElementById('feedback-text');
    if (feedbackInput) {
        feedbackInput.addEventListener('input', recordUserActivity, { passive: true });
        feedbackInput.addEventListener('focus', recordUserActivity, { passive: true });
    }

    // 定期检查是否需要发送保活
    keepAliveCheckInterval = setInterval(() => {
        const idleMs = Date.now() - lastActivityTime;
        if (idleMs >= KEEP_ALIVE_IDLE_MS && currentFeedbackSession && isConnected && socket) {
            console.log(`用户空闲 ${Math.round(idleMs / 1000)}秒，发送保活信号`);
            socket.emit('keep_alive', { sessionId: currentFeedbackSession });
            // 重置 activity 时间，避免连续发送
            lastActivityTime = Date.now();
        }
    }, KEEP_ALIVE_CHECK_MS);

    console.log('空闲保活监控已启动');
}

/**
 * 停止空闲保活监控
 */
function stopKeepAliveMonitor() {
    if (keepAliveCheckInterval) {
        clearInterval(keepAliveCheckInterval);
        keepAliveCheckInterval = null;
    }
}

// ============================================================
// 临时任务（pending instructions）UI
//   - 右上角浮动按钮，点击弹出输入框
//   - 用户提交后写入服务器；agent 在 collect_feedback 之前会先 check 取走
//   - 队列里有任务时按钮显示数字角标
// ============================================================

const PENDING_API = '/api/pending-instructions';
let pendingPollTimer = null;

function initPendingInstructionsUI() {
    if (document.getElementById('pti-fab')) return; // 防重复
    injectPendingStyles();
    injectPendingDom();
    bindPendingHandlers();
    refreshPendingList();
    if (pendingPollTimer) clearInterval(pendingPollTimer);
    pendingPollTimer = setInterval(refreshPendingList, 5000);
}

function injectPendingStyles() {
    const css = `
    .pti-fab {
      position: fixed; top: 20px; right: 160px;
      z-index: 9998;
      background: #c9a227; color: #1e1e1e;
      border: none; border-radius: 6px;
      padding: 7px 14px; font-size: 12px; font-weight: 600;
      cursor: pointer; box-shadow: 0 2px 10px rgba(201,162,39,0.35);
      transition: transform 0.12s, box-shadow 0.18s;
      display: inline-flex; align-items: center; gap: 6px;
      font-family: inherit;
    }
    .pti-fab:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(201,162,39,0.55); }
    .pti-fab .pti-badge {
      display: inline-block; min-width: 18px; height: 18px; padding: 0 5px;
      background: #ff4d4f; color: #fff; border-radius: 9px;
      font-size: 11px; line-height: 18px; text-align: center; font-weight: 700;
    }
    .pti-mask {
      position: fixed; inset: 0; z-index: 9999;
      background: rgba(0,0,0,0.5); display: none;
      align-items: center; justify-content: center;
    }
    .pti-mask.visible { display: flex; }
    .pti-card {
      background: #252526; color: #cccccc;
      width: 480px; max-width: 92vw; max-height: 85vh; overflow: auto;
      border-radius: 8px; padding: 22px 24px;
      border: 1px solid #3c3c3c; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .pti-card h3 { margin: 0 0 6px; font-size: 16px; color: #fff; }
    .pti-card .pti-tip { margin: 0 0 14px; font-size: 12px; color: #969696; line-height: 1.6; }
    .pti-card textarea {
      width: 100%; min-height: 80px; max-height: 200px;
      background: #1e1e1e; color: #e8e8e8;
      border: 1px solid #3c3c3c; border-radius: 4px;
      padding: 10px 12px; font-size: 13px; font-family: inherit; resize: vertical;
    }
    .pti-card textarea:focus { outline: none; border-color: #c9a227; }
    .pti-list-wrap {
      margin-top: 16px; padding-top: 12px;
      border-top: 1px solid #3c3c3c;
    }
    .pti-list-title {
      font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
      color: #c9a227; margin-bottom: 8px; font-weight: 700;
    }
    .pti-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; }
    .pti-list li {
      display: flex; gap: 8px; align-items: flex-start;
      padding: 6px 8px; border-bottom: 1px solid #2d2d2d;
      font-size: 12px;
    }
    .pti-list li:last-child { border-bottom: none; }
    .pti-list-content { flex: 1; word-break: break-word; }
    .pti-list-time { color: #6c6c6c; font-size: 10px; }
    .pti-list-del {
      background: none; border: none; color: #888;
      cursor: pointer; font-size: 14px; line-height: 1;
    }
    .pti-list-del:hover { color: #ff4d4f; }
    .pti-empty { color: #6c6c6c; font-style: italic; padding: 8px 4px; }
    .pti-buttons {
      display: flex; gap: 10px; justify-content: flex-end;
      margin-top: 18px;
    }
    .pti-buttons button {
      padding: 7px 16px; border-radius: 4px; font-size: 12px;
      cursor: pointer; border: 1px solid #3c3c3c;
      background: #2d2d2d; color: #cccccc; font-family: inherit;
    }
    .pti-buttons button:hover { background: #3a3a3a; }
    .pti-buttons button.primary {
      background: #c9a227; border-color: #c9a227; color: #1e1e1e; font-weight: 700;
    }
    .pti-buttons button.primary:hover { background: #b8901c; border-color: #b8901c; }
    .pti-buttons button.danger {
      background: transparent; border-color: #5a3030; color: #ff7a7a;
    }
    .pti-buttons button.danger:hover { background: #3a2020; }
    .pti-error { color: #ff7a7a; font-size: 12px; margin-top: 8px; min-height: 16px; }
    `;
    const style = document.createElement('style');
    style.id = 'pti-style';
    style.textContent = css;
    document.head.appendChild(style);
}

function injectPendingDom() {
    const fab = document.createElement('button');
    fab.id = 'pti-fab';
    fab.className = 'pti-fab';
    fab.title = '插入临时任务给 AI（AI 下次调用 collect_feedback 之前会先取走）';
    fab.innerHTML = '📥 插入临时任务<span class="pti-badge" id="pti-badge" style="display:none">0</span>';
    document.body.appendChild(fab);

    const mask = document.createElement('div');
    mask.id = 'pti-mask';
    mask.className = 'pti-mask';
    mask.innerHTML = `
      <div class="pti-card" id="pti-card">
        <h3>📥 插入临时任务</h3>
        <p class="pti-tip">
          AI 在下次调用 collect_feedback 之前会先来取走这些任务并按 FIFO 顺序执行。<br />
          取走后会立即从队列中移除（不会重复执行）。
        </p>
        <textarea id="pti-input" placeholder="例如：把刚才那个按钮颜色改成蓝色，再加一个 hover 效果"></textarea>
        <div class="pti-error" id="pti-error"></div>

        <div class="pti-list-wrap">
          <div class="pti-list-title">待办队列 (FIFO，共 <span id="pti-count">0</span> 条)</div>
          <ul id="pti-list" class="pti-list">
            <li class="pti-empty">暂无</li>
          </ul>
        </div>

        <div class="pti-buttons">
          <button id="pti-clear" class="danger">清空</button>
          <button id="pti-cancel">关闭</button>
          <button id="pti-submit" class="primary">提交</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);
}

function bindPendingHandlers() {
    const fab = document.getElementById('pti-fab');
    const mask = document.getElementById('pti-mask');
    const card = document.getElementById('pti-card');
    const input = document.getElementById('pti-input');
    const submit = document.getElementById('pti-submit');
    const cancel = document.getElementById('pti-cancel');
    const clearBtn = document.getElementById('pti-clear');

    const open = () => {
        mask.classList.add('visible');
        refreshPendingList();
        setTimeout(() => input?.focus(), 50);
    };
    const close = () => {
        mask.classList.remove('visible');
        setPendingError('');
    };

    fab.addEventListener('click', open);
    cancel.addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    card.addEventListener('click', (e) => e.stopPropagation());

    input.addEventListener('keydown', (e) => {
        // Ctrl/Cmd+Enter 提交（避免和换行冲突）
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            submitPending();
        }
    });

    submit.addEventListener('click', submitPending);
    clearBtn.addEventListener('click', clearPending);
}

async function submitPending() {
    const input = document.getElementById('pti-input');
    const content = (input?.value || '').trim();
    if (!content) {
        setPendingError('请填写指令内容');
        return;
    }
    setPendingError('');
    try {
        const r = await fetch(PENDING_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || '提交失败');
        input.value = '';
        await refreshPendingList();
        try { showStatusMessage('success', '已插入临时任务'); } catch (_) {}
    } catch (e) {
        setPendingError(e.message || '网络错误');
    }
}

async function refreshPendingList() {
    try {
        const r = await fetch(PENDING_API);
        const d = await r.json();
        if (!d.success) return;
        const list = d.instructions || [];
        renderPendingList(list);
        renderPendingBadge(list.length);
    } catch (_) { /* swallow */ }
}

function renderPendingBadge(count) {
    const badge = document.getElementById('pti-badge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = String(count);
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

function renderPendingList(list) {
    const ul = document.getElementById('pti-list');
    const cnt = document.getElementById('pti-count');
    if (!ul) return;
    if (cnt) cnt.textContent = String(list.length);
    if (!list.length) {
        ul.innerHTML = '<li class="pti-empty">暂无</li>';
        return;
    }
    ul.innerHTML = list.map((it, idx) => `
      <li>
        <span class="pti-list-content"><b>#${idx + 1}</b> ${escapeHtml(it.content)}<br /><span class="pti-list-time">${new Date(it.createdAt).toLocaleString()}</span></span>
        <button class="pti-list-del" data-id="${it.id}" title="取消这条">✕</button>
      </li>
    `).join('');
    ul.querySelectorAll('.pti-list-del').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            await cancelPending(id);
        });
    });
}

async function cancelPending(id) {
    try {
        await fetch(`${PENDING_API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refreshPendingList();
    } catch (_) { /* swallow */ }
}

async function clearPending() {
    if (!confirm('确认清空所有 pending 任务？')) return;
    try {
        await fetch(PENDING_API, { method: 'DELETE' });
        await refreshPendingList();
    } catch (_) { /* swallow */ }
}

function setPendingError(msg) {
    const el = document.getElementById('pti-error');
    if (el) el.textContent = msg || '';
}

function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// 📝 草稿历史 — 实时存档 + 失败恢复
// ============================================================

function _draftsLoad() {
    try {
        const raw = localStorage.getItem(DRAFTS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        console.warn('[drafts] 解析失败，重置为空', e);
        return [];
    }
}

function _draftsSave(arr) {
    try {
        // 始终按 ts 倒序，截到 DRAFTS_MAX
        const sorted = arr
            .slice()
            .sort((a, b) => (b.ts || 0) - (a.ts || 0))
            .slice(0, DRAFTS_MAX);
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(sorted));
    } catch (e) {
        console.warn('[drafts] 写入 localStorage 失败', e);
    }
}

function _draftsGenId() {
    return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 实时保存当前草稿（debounce）
 * - 文本为空 + 草稿状态为 editing → 删除该草稿（避免空记录）
 * - 文本非空 → 更新或插入
 */
function saveCurrentDraft(text) {
    if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(() => {
        const drafts = _draftsLoad();
        const trimmed = (text || '').trim();

        if (!trimmed) {
            // 空 → 移除当前 editing 草稿
            if (_currentDraftId) {
                const idx = drafts.findIndex(d => d.id === _currentDraftId);
                if (idx >= 0 && drafts[idx].status === 'editing') {
                    drafts.splice(idx, 1);
                    _draftsSave(drafts);
                    _currentDraftId = null;
                    renderDraftsList();
                }
            }
            return;
        }

        // 非空：更新或插入
        if (!_currentDraftId) {
            _currentDraftId = _draftsGenId();
        }
        const idx = drafts.findIndex(d => d.id === _currentDraftId);
        const entry = {
            id: _currentDraftId,
            ts: Date.now(),
            text,
            sessionId: currentFeedbackSession || null,
            status: 'editing',
        };
        if (idx >= 0) {
            // 保留之前 status（被标记 sent/failed 的不应回滚到 editing）
            // 但用户继续编辑同一条 → 应当复活为 editing
            drafts[idx] = { ...drafts[idx], ...entry, status: 'editing' };
        } else {
            drafts.push(entry);
        }
        _draftsSave(drafts);
        renderDraftsList();
    }, DRAFT_DEBOUNCE_MS);
}

/**
 * 标记当前正在编辑的草稿为某种状态
 * 提交开始时不立即标记；提交成功才标 sent；提交失败/超时标 failed。
 */
function markCurrentDraft(status) {
    if (!_currentDraftId) return;
    const drafts = _draftsLoad();
    const idx = drafts.findIndex(d => d.id === _currentDraftId);
    if (idx >= 0) {
        drafts[idx] = {
            ...drafts[idx],
            status,
            ts_status: Date.now(),
        };
        _draftsSave(drafts);
    }
    if (status === 'sent') {
        // 提交成功 → 释放 currentDraftId，下次输入开新草稿
        _currentDraftId = null;
    }
    renderDraftsList();
}

function deleteDraft(id) {
    const drafts = _draftsLoad().filter(d => d.id !== id);
    _draftsSave(drafts);
    if (_currentDraftId === id) _currentDraftId = null;
    renderDraftsList();
}

function clearAllDrafts() {
    if (!confirm('确认清空所有草稿？此操作不可恢复。')) return;
    localStorage.removeItem(DRAFTS_KEY);
    _currentDraftId = null;
    renderDraftsList();
}

function restoreDraft(id) {
    const drafts = _draftsLoad();
    const d = drafts.find(x => x.id === id);
    if (!d) return;
    const ta = document.getElementById('feedback-text');
    if (!ta) return;
    ta.value = d.text || '';
    // 切到 feedback tab 让用户看到
    if (typeof showTab === 'function') showTab('feedback');
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 让 currentDraftId 指向恢复的这条，继续编辑就在原条上更新
    _currentDraftId = d.id;
    showStatusMessage('success', '已恢复草稿到输入框', true);
}

function renderDraftsList() {
    const list = document.getElementById('drafts-list');
    const badge = document.getElementById('drafts-badge');
    if (!list) return;
    const drafts = _draftsLoad();
    if (badge) {
        if (drafts.length > 0) {
            badge.hidden = false;
            badge.textContent = String(drafts.length);
        } else {
            badge.hidden = true;
        }
    }
    if (drafts.length === 0) {
        list.innerHTML = '<div class="drafts-empty">暂无草稿</div>';
        return;
    }
    list.innerHTML = drafts.map(d => {
        const status = d.status || 'editing';
        const statusLabel = { editing: '编辑中', sent: '已提交', failed: '提交失败' }[status] || status;
        const time = new Date(d.ts).toLocaleString();
        return `
          <div class="draft-item draft-status-${status}" data-id="${d.id}">
            <div class="draft-item-meta">
              <span class="draft-item-status">${statusLabel}</span>
              <span>${time}</span>
            </div>
            <div class="draft-item-text">${escapeHtml(d.text || '')}</div>
            <div class="draft-item-actions">
              <button class="draft-action-btn" data-action="restore" data-id="${d.id}">恢复</button>
              <button class="draft-action-btn danger" data-action="delete" data-id="${d.id}">删除</button>
            </div>
          </div>
        `;
    }).join('');
    list.querySelectorAll('.draft-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            const action = btn.getAttribute('data-action');
            if (action === 'restore') restoreDraft(id);
            if (action === 'delete') deleteDraft(id);
        });
    });
    // 整条点击也恢复
    list.querySelectorAll('.draft-item').forEach(it => {
        it.addEventListener('click', () => {
            const id = it.getAttribute('data-id');
            restoreDraft(id);
        });
    });
}

function initDraftsUI() {
    const drawer = document.getElementById('drafts-drawer');
    const toggle = document.getElementById('drafts-toggle');
    const clearBtn = document.getElementById('drafts-clear-btn');
    const ta = document.getElementById('feedback-text');
    if (!drawer || !toggle || !ta) return;

    toggle.addEventListener('click', () => {
        drawer.classList.toggle('collapsed');
    });
    if (clearBtn) clearBtn.addEventListener('click', clearAllDrafts);

    // 输入实时存档（debounce）
    ta.addEventListener('input', () => {
        saveCurrentDraft(ta.value);
    });

    // 提交成功事件 → 标 sent
    document.addEventListener('mcp:feedback-sent', () => markCurrentDraft('sent'));
    // 提交失败事件 → 标 failed
    document.addEventListener('mcp:feedback-failed', () => markCurrentDraft('failed'));

    // 首次渲染
    renderDraftsList();
}

