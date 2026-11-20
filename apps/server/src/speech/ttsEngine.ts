// TTS 合成引擎：整句合成 + 多端点重试（网络失败/限流退避）。
// 从 session.ts 抽出，独立于会话状态——只关心「给定端点，把一段文字合成出 PCM 并推进播放队列」。
import { streamTTS, isNetworkError, isRateLimitError } from './cosyvoiceRealtime';
import type { RealtimeTTSInput } from './cosyvoiceRealtime';

const TTS_MAX_ATTEMPTS = 3;
const TTS_NETWORK_BACKOFF_MS = 600;
const TTS_RATELIMIT_BACKOFF_MS = 2000;

export type TtsEndpoint = { url: string; key: string };

// 从配置拼出（主端点 + 可选兜底端点）。
export function buildTtsEndpoints(cfg: {
  dashscopeWsUrl: string;
  dashscopeApiKey: string;
  dashscopeWsFallbackUrl?: string;
  dashscopeOfficialApiKey?: string;
}): TtsEndpoint[] {
  const eps: TtsEndpoint[] = [{ url: cfg.dashscopeWsUrl, key: cfg.dashscopeApiKey }];
  if (cfg.dashscopeWsFallbackUrl && cfg.dashscopeOfficialApiKey) {
    eps.push({ url: cfg.dashscopeWsFallbackUrl, key: cfg.dashscopeOfficialApiKey });
  }
  return eps;
}

export class TtsEngine {
  constructor(
    private readonly endpoints: TtsEndpoint[],
    private readonly pushPcm: (pcm: Uint8Array) => void,
    private readonly onStart: () => void,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  // 整句合成：先缓冲完整句再一次性进队列（逐句顺序放，避免「来一段放一段」的流式卡顿）。
  async synthesize(params: Omit<RealtimeTTSInput, 'wsUrl' | 'apiKey'>): Promise<void> {
    let lastErr: unknown = null;
    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      let attempt = 0;
      while (true) {
        try {
          this.onStart();
          const acc: Uint8Array[] = [];
          for await (const pcm of streamTTS({ ...params, wsUrl: ep.url, apiKey: ep.key })) {
            if (params.signal?.aborted) break;
            acc.push(pcm);
          }
          if (params.signal?.aborted) return;
          for (const pcm of acc) this.pushPcm(pcm);
          return;
        } catch (e) {
          if (params.signal?.aborted) return;
          lastErr = e;
          if (!isNetworkError(e) && !isRateLimitError(e)) throw e;
          const rateLimit = isRateLimitError(e);
          attempt++;
          if (attempt >= TTS_MAX_ATTEMPTS) break;
          const wait = (rateLimit ? TTS_RATELIMIT_BACKOFF_MS : TTS_NETWORK_BACKOFF_MS) * attempt;
          const reason = (e as { code?: string })?.code ?? (e as Error)?.message ?? String(e);
          console.log(`[TTS] ${rateLimit ? '限流' : '网络失败'}（${reason}），${wait}ms 后重试（端点 ${i + 1}/${this.endpoints.length} 第 ${attempt} 次）`);
          await this.sleep(wait);
        }
      }
      if (i < this.endpoints.length - 1) {
        console.log(`[TTS] 端点 ${ep.url} 多次失败，切兜底端点`);
      }
    }
    throw lastErr;
  }
}
