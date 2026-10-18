// cdp-client.mjs - CDP 客户端封装
// 从 orchestrate.mjs 提取
//
// T-56 W2.1 重写 connect()（回归债 DELTA-027 自递归 + DELTA-034 强制 wss）：
//   - 删除 attemptConnect 自递归（旧实现每次调用再 new Promise 调 this.connect()，
//     永不 resolve，reject 分支是死代码，实际栈溢出 RangeError）
//   - 删除 ws -> wss 强制替换（CDP debug 端口只提供 ws://127.0.0.1:9222）
//   - 单次尝试失败立即 reject；外层简单 loop 重试 <= maxAttempts，指数退避，无递归
//   - WebSocket 实现可注入（测试用 fake），默认 globalThis.WebSocket
// 行为契约见 orchestrator/test/cdp-client.test.mjs（5 条）。

export class CDP {
  constructor(wsUrl, webSocketImpl = null) {
    this.wsUrl = wsUrl;
    this.WSImpl = webSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map(); // 事件订阅：method -> Set<fn>（T-58 waitForEvent 用）
  }
  async connect(options = {}) {
    const maxAttempts = options.maxAttempts ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const attemptTimeoutMs = options.attemptTimeoutMs ?? 15000;
    if (!this.WSImpl) {
      throw new Error('CDP: no WebSocket implementation available');
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 2)));
      }
      try {
        await this._attemptOnce(attemptTimeoutMs);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    this.ws = null;
    throw new Error('CDP connect failed after ' + maxAttempts + ' attempt(s): ' + (lastErr ? lastErr.message : 'unknown'));
  }
  _attemptOnce(attemptTimeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const ws = new this.WSImpl(this.wsUrl);
      this.ws = ws;
      const wsTimer = setTimeout(() => {
        if (ws.close) { try { ws.close(); } catch (_) {} }
        finish(reject, new Error('timeout ' + attemptTimeoutMs + 'ms: WebSocket connect'));
      }, attemptTimeoutMs);
      ws.onopen = () => { clearTimeout(wsTimer); finish(resolve); };
      ws.onerror = (e) => {
        clearTimeout(wsTimer);
        finish(reject, new Error('WS error: ' + ((e && e.message) || 'unknown')));
      };
      ws.onclose = (e) => {
        clearTimeout(wsTimer);
        finish(reject, new Error('WS closed before open: ' + ((e && e.message) || 'unknown')));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else if (msg.method && this.eventHandlers.has(msg.method)) {
          for (const fn of Array.from(this.eventHandlers.get(msg.method))) {
            try { fn(msg.params || {}, msg.sessionId); } catch (_) {}
          }
        }
      };
    });
  }
  onEvent(method, fn) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method).add(fn);
    return () => this.offEvent(method, fn);
  }
  offEvent(method, fn) {
    const s = this.eventHandlers.get(method);
    if (s) { s.delete(fn); if (s.size === 0) this.eventHandlers.delete(method); }
  }
  waitForEvent(method, timeoutMs = 5000, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const handler = (params, sid) => {
        if (sessionId !== undefined && sid !== sessionId) return;
        if (timer) { clearTimeout(timer); timer = null; }
        this.offEvent(method, handler);
        resolve(params);
      };
      this.onEvent(method, handler);
      timer = setTimeout(() => {
        this.offEvent(method, handler);
        reject(new Error('timeout waiting event ' + method));
      }, timeoutMs);
    });
  }
  send(method, params = {}, sessionId = undefined, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + timeoutMs + 'ms: ' + method));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export default CDP;