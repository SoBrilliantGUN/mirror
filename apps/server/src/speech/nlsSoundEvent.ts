import WebSocket from 'ws';
import { createHmac, randomUUID } from 'node:crypto';
import type { VocalizationEvent } from '@mirror/contracts';
import { toBuffer } from './wsUtil';

// 阿里云智能语音交互（NLS）声音事件检测：云端实时检测哭/笑（Cry/Laughter）。
// 零本地模型——16kHz PCM 流式上行，回事件 + 起止时间 + 置信度。
//
// 协议（核实自 aliyun/alibabacloud-nls-python-sdk / -java-sdk）：
// - 鉴权：token 拼进 WS URL；token 可提前拿好直接传，也可用 AccessKey 走 CreateToken 现拿。
// - WS：wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=...
// - 命令帧 = JSON 文本帧（header: message_id/task_id/namespace/name/appkey），音频 = 二进制帧。
// - namespace = AudioEventDetection；start 命令 name = StartTask；stop = StopTask；结果 name = TaskResult。

const GATEWAY = 'wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1';
const META = 'https://nls-meta.cn-shanghai.aliyuncs.com/';
const NAMESPACE = 'AudioEventDetection';

// 重连策略：指数退避 + 上限，避免永久性错误（如 403）无限刷屏。
const MAX_RECONNECT_ATTEMPTS = 5;   // 连续重连上限，超出后放弃
const RECONNECT_BASE_MS = 5000;     // 首次重连等待
const RECONNECT_MAX_MS = 30000;     // 退避封顶

// NLS 事件名 → 我们的哭/笑二分类
const CRY_EVENTS = new Set(['Cry']);
const LAUGH_EVENTS = new Set(['Laughter']);

function percentEncode(s: string): string {
  // 阿里云 RPC 签名要求按 RFC3986 编码，encodeURIComponent 不编码 !'()*，这里补上。
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// CreateToken：阿里云 POP RPC 签名（V1）。只在没直接给 token 时用。
async function getToken(akId: string, akSecret: string): Promise<string> {
  const params: Record<string, string> = {
    AccessKeyId: akId,
    Action: 'CreateToken',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = createHmac('sha1', `${akSecret}&`).update(stringToSign).digest('base64');

  const res = await fetch(`${META}?${canonical}&Signature=${percentEncode(signature)}`, { method: 'POST' });
  const data = (await res.json()) as { Token?: { Id?: string } };
  const id = data.Token?.Id;
  if (!id) throw new Error(`NLS CreateToken 失败：${JSON.stringify(data)}`);
  return id;
}

export type NlsEventCallback = (event: VocalizationEvent) => void;

export type NlsDetectorOptions = {
  appKey: string;          // NLS 项目 AppKey（StartDetection 命令 header 里要）
  token?: string;          // 已拿好的 token（优先；设了就不走 CreateToken）
  akId?: string;           // AccessKeyId（没 token 时用，走 CreateToken 现拿）
  akSecret?: string;       // AccessKeySecret
};

export class NlsSoundEventDetector {
  private ws: WebSocket | null = null;
  private taskId = '';
  private startedAt = 0;
  private closed = false;                                          // 主动关闭标记（不重连）
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPcmAt = 0;                                           // 最近一次发音频时间（心跳用）
  private cachedToken: string | null = null;                       // 缓存 token，重连复用
  private reconnectAttempts = 0;                                   // 连续重连次数（连上就清零）
  private authFailed = false;                                      // 鉴权失败（401/403）：永久性错误，不再重连

  constructor(private opts: NlsDetectorOptions, private onEvent: NlsEventCallback) {}

  // 连 NLS。WS 连上、发完 StartDetection 就返回，让调用方马上喂音频。
  // 失败 resolve（不抛），后续 sendPcm 静默丢弃——主链路照常。
  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.taskId = randomUUID().replace(/-/g, '');
    this.clearTimers(); // 重连前清掉旧的心跳/重连定时器

    let token = this.opts.token ?? this.cachedToken;
    if (!token) {
      if (!this.opts.akId || !this.opts.akSecret) {
        console.warn('[NLS] 既没配 token 也没配 AccessKey，哭/笑检测关闭');
        return;
      }
      try {
        token = await getToken(this.opts.akId, this.opts.akSecret);
        this.cachedToken = token;
      } catch (e) {
        console.warn(`[NLS] 拿 token 失败（哭/笑检测降级为无事件）：${(e as Error)?.message ?? e}`);
        return;
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const ws = new WebSocket(`${GATEWAY}?token=${encodeURIComponent(token!)}`);
      this.ws = ws;

      ws.on('open', () => {
        const header = {
          message_id: randomUUID().replace(/-/g, ''),
          task_id: this.taskId,
          namespace: NAMESPACE,
          name: 'StartTask',
          appkey: this.opts.appKey,
        };
        ws.send(
          JSON.stringify({
            header,
            payload: { format: 'pcm', sample_rate: 16000 },
            context: { sdk: { name: 'nls-node', version: '0.0.1', language: 'nodejs' } },
          }),
        );
        this.reconnectAttempts = 0; // 连上了，重连计数清零
        console.log('[NLS] 已连上、已发 StartDetection');
        this.startHeartbeat();
        done();
      });

      ws.on('error', (e) => {
        const msg = (e as Error)?.message ?? String(e);
        if (/401|403/i.test(msg)) {
          // 鉴权失败 = token 过期/失效，重试一万次也还是 403 → 标记致命、停用重连。
          this.authFailed = true;
          console.warn(`[NLS] 鉴权失败（${msg}）：token 过期或失效。请刷新 NLS_ACCESS_TOKEN，或改配 NLS_ACCESS_KEY_ID/SECRET 走 CreateToken。哭/笑检测本次停用。`);
        } else {
          console.warn(`[NLS] 声音事件检测连接失败（降级为无事件）：${msg}`);
        }
        done();
      });

      ws.on('close', () => {
        console.warn('[NLS] 声音事件检测连接已断开');
        if (this.ws !== ws) return; // 旧连接的 close，忽略（已重连到新连接）
        this.clearTimers();
        if (!this.closed && !this.authFailed) this.scheduleReconnect();
      });

      ws.on('message', (data) => {
        const buf = toBuffer(data);
        // 事件 = JSON 文本帧（首字节 '{'）；服务端不会回音频
        if (buf.length === 0 || buf[0] !== 0x7b) return;
        let msg: { header?: { name?: string }; payload?: unknown };
        try {
          msg = JSON.parse(buf.toString('utf8'));
        } catch {
          return;
        }
        const name = msg.header?.name;
        if (name === 'TaskResult') {
          this.emitFromResult(msg.payload);
        } else if (name === 'TaskFailed') {
          console.warn('[NLS] 检测任务失败：', JSON.stringify(msg));
        } else {
          // started / stopped / completed 等其它事件：打日志方便对名字
          console.log('[NLS] 收到事件：', name, JSON.stringify(msg).slice(0, 300));
        }
      });
    });
  }

  // TaskResult payload = { number, result: [{ event_type, confidence, start_time, end_time }] }。
  private emitFromResult(payload: unknown): void {
    const result = (payload as { result?: unknown })?.result;
    const events = Array.isArray(result) ? result : [];
    for (const e of events as Array<Record<string, unknown>>) {
      const type = e?.event_type;
      const conf = typeof e?.confidence === 'number' ? (e.confidence as number) : undefined;
      if (CRY_EVENTS.has(String(type))) {
        this.onEvent({ type: 'cry', at: Date.now() - this.startedAt, confidence: conf });
      } else if (LAUGH_EVENTS.has(String(type))) {
        this.onEvent({ type: 'laugh', at: Date.now() - this.startedAt, confidence: conf });
      }
    }
  }

  sendPcm(chunk: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.lastPcmAt = Date.now();
      this.ws.send(Buffer.from(chunk));
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // 心跳：长时间没音频时发静音保活，避免网关 IDLE_TIMEOUT 踢掉
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastPcmAt > 5000) {
        this.ws.send(Buffer.alloc(3200)); // 100ms 16kHz 16bit 静音
      }
    }, 5000);
  }

  // 重连：非主动关闭时，断开后指数退避重连；连续失败到上限或鉴权失败就放弃。
  private scheduleReconnect(): void {
    if (this.closed || this.authFailed || this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[NLS] 连续重连 ${this.reconnectAttempts} 次仍未连上，放弃重连（哭/笑检测停用）`);
      this.closed = true; // 当作关闭：停止后续重连
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    console.log(`[NLS] ${Math.round(delay / 1000)}s 后重连（第 ${this.reconnectAttempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.authFailed) return;
      console.log('[NLS] 尝试重连…');
      this.start().catch((e) => console.warn('[NLS] 重连失败：', (e as Error)?.message ?? e));
    }, delay);
  }
}
