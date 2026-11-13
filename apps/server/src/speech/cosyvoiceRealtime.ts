import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { toBuffer } from './wsUtil';

export type RealtimeTTSInput = {
  wsUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  instruction: string;
  text: string;
  format?: string;      // 默认 'pcm'
  sampleRate?: number;  // 默认 24000
  rate?: number;        // 默认 1.0
  pitch?: number;       // 默认 1.0
  connectTimeoutMs?: number; // 连接（TCP+握手）超时，默认 8000ms
  signal?: AbortSignal; // 打断时中止合成、丢弃未发音频
};

type EventMsg = { header?: { event?: string; error_code?: string; error_message?: string } };

// 网络层错误码：连接超时/被重置/拒连/解析失败等，都值得退避重试（可换兜底端点）。
const NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function isNetworkError(e: unknown): boolean {
  const err = e as { code?: string; message?: string; errors?: Array<{ code?: string }> } | null;
  if (!err) return false;
  if (typeof err.code === 'string' && NETWORK_CODES.has(err.code)) return true;
  // Node Happy Eyeballs（autoSelectFamily）会把多地址失败包成 AggregateError，逐个看内层 code
  if (Array.isArray(err.errors)) {
    return err.errors.some((inner) => typeof inner?.code === 'string' && NETWORK_CODES.has(inner.code));
  }
  return false;
}

export function isRateLimitError(e: unknown): boolean {
  const err = e as { message?: string; code?: string } | null;
  const text = String(err?.message ?? err?.code ?? '');
  return /rate\s*limit|RateQuota|Throttling|\b429\b/i.test(text);
}

// 阿里云百炼把 JSON 事件也发成二进制帧，所以要先判断是不是 JSON 事件（首字节 '{'）。
function tryParseEvent(buf: Buffer): EventMsg | null {
  if (buf.length === 0 || buf[0] !== 0x7b) return null; // '{'
  try {
    const msg = JSON.parse(buf.toString('utf8')) as EventMsg;
    return msg && msg.header ? msg : null;
  } catch {
    return null;
  }
}

// 阿里云百炼 CosyVoice 实时 TTS：WebSocket 流式出 PCM。
export async function* streamTTS(input: RealtimeTTSInput): AsyncGenerator<Uint8Array> {
  const taskId = randomUUID();
  const ws = new WebSocket(input.wsUrl, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
  });
  const signal = input.signal;

  const queue: Uint8Array[] = [];
  let finished = false;
  let failed: Error | null = null;
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((w) => w());
  const send = (o: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
  };

  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  const fail = (err: Error) => {
    if (finished) return;
    finished = true;
    failed = err;
    queue.length = 0; // 丢弃已收未发的音频，避免打断后还漏出一句
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    notify();
    try {
      ws.close();
    } catch {
      /* 连接可能尚未建立 */
    }
  };

  const abort = () => fail(new Error('TTS aborted'));

  // 连接超时兜底：TCP+握手迟迟不 open 就当网络失败，交给上层重试/切端点（否则可能卡到 OS 默认 ~2min）。
  connectTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      const err = new Error('TTS connect timeout');
      (err as unknown as { code?: string }).code = 'ETIMEDOUT';
      fail(err);
    }
  }, input.connectTimeoutMs ?? 8000);
  if (typeof connectTimer.unref === 'function') connectTimer.unref();

  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });

  ws.on('open', () => {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    send({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: input.model,
        input: {},
        parameters: {
          voice: input.voice,
          instruction: input.instruction,
          format: input.format ?? 'pcm',
          sample_rate: input.sampleRate ?? 24000,
          rate: input.rate ?? 1.0,
          pitch: input.pitch ?? 1.0,
        },
      },
    });
  });

  ws.on('message', (data) => {
    const buf = toBuffer(data);
    const event = tryParseEvent(buf);
    if (event) {
      const name = event.header?.event;
      if (name === 'task-started') {
        send({ header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' }, payload: { input: { text: input.text } } });
        send({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } });
      } else if (name === 'task-finished') {
        // 不在这里立刻 ws.close()：音频帧先于 task-finished 到达，立刻关可能截掉最后一帧。
        // 置 finished + notify 让循环自然收尾，延迟 200ms 再关兜底（等服务端自己关）。
        finished = true;
        notify();
        setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }, 200);
      } else if (name === 'task-failed') {
        failed = new Error(`TTS task-failed: ${event.header?.error_code ?? ''} ${event.header?.error_message ?? ''}`);
        finished = true;
        notify();
        ws.close();
      }
      return;
    }
    // 否则是二进制 PCM 音频
    queue.push(new Uint8Array(buf));
    notify();
  });

  ws.on('error', (e) => {
    fail(e as Error);
  });
  ws.on('close', () => {
    finished = true;
    notify();
  });

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) break;
    await new Promise<void>((r) => waiters.push(r));
  }
  if (failed) throw failed;
}
