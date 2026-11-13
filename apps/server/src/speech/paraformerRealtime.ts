import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { toBuffer } from './wsUtil';

export type RealtimeASRInput = {
  wsUrl: string;
  apiKey: string;
  model: string;
  format?: string;          // 默认 'pcm'
  sampleRate?: number;      // 默认 16000
  languageHints?: string[];
  onResult: (text: string, isFinal: boolean) => void;
};

// 阿里云百炼 Paraformer 实时 ASR：WebSocket 发 PCM、收识别结果（含 interim）。
export class ParaformerRealtimeASR {
  private ws: WebSocket | null = null;
  private taskId: string | null = null;

  async start(input: RealtimeASRInput): Promise<void> {
    this.taskId = randomUUID();
    const ws = new WebSocket(input.wsUrl, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model: input.model,
              input: {},
              parameters: {
                format: input.format ?? 'pcm',
                sample_rate: input.sampleRate ?? 16000,
                semantic_punctuation_enabled: false, // VAD 断句，低延迟
                language_hints: input.languageHints ?? ['zh'],
              },
            },
          }),
        );
        resolve(); // WebSocket open、run-task 已发，start() 可以返回
      });

      ws.on('message', (data) => {
        const buf = toBuffer(data);
        // 阿里云百炼把 JSON 事件也发成二进制帧：首字节 '{' = 事件，否则是音频（服务端不会下发音频）
        if (buf.length === 0 || buf[0] !== 0x7b) return;
        const msg = JSON.parse(buf.toString('utf8')) as {
          header?: { event?: string };
          output?: { sentence?: { text?: string; sentence_end?: boolean } };
          payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } };
        };
        if (msg.header?.event === 'result-generated') {
          const sentence = msg.output?.sentence ?? msg.payload?.output?.sentence;
          const text = sentence?.text ?? '';
          const isFinal = sentence?.sentence_end === true; // 说完了（VAD 断句结束）
          if (text) input.onResult(text, isFinal);
        }
      });

      ws.on('error', reject);
    });
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(Buffer.from(chunk));
    }
  }

  finish(): void {
    if (this.ws && this.taskId && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
          payload: { input: {} },
        }),
      );
    }
  }

  close(): void {
    this.ws?.close();
  }
}
