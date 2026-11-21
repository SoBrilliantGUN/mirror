// TTS 合成引擎：整句合成 + 多端点重试（网络失败/限流退避）。
// 从 session.ts 抽出，独立于会话状态——只关心「给定端点，把一段文字合成出 PCM 并推进播放队列」。
import { streamTTS, isNetworkError, isRateLimitError } from './cosyvoiceRealtime';
import type { RealtimeTTSInput } from './cosyvoiceRealtime';

const TTS_MAX_ATTEMPTS = 3;
const TTS_NETWORK_BACKOFF_MS = 600;
const TTS_RATELIMIT_BACKOFF_MS = 2000;

// TTS 易读替换表：生僻字/易念错的字 → 同音常用字。只影响「念出来」的发音，不影响落库/回看显示的原文。
const TTS_EASY_READ: Record<string, string> = {
  渔: '鱼', // 「渔」生僻，CosyVoice 会把「渔歌」念成 yegeten，换同音的「鱼」
};

// 把句子里的易念错字换成同音常用字，喂给 TTS 念。
function toTtsText(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(TTS_EASY_READ)) out = out.replaceAll(from, to);
  return out;
}

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
    private readonly pushPcm: (pcm: Uint8Array, onFirstFrame?: () => void) => void,
    private readonly onStart: () => void,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  // 整句合成：先缓冲完整句再一次性进队列（逐句顺序放，避免「来一段放一段」的流式卡顿）。
  // onFirstFrame 只在该句第一帧真正开始播放时触发一次（字幕与声音对齐，重试期间不触发）。
  async synthesize(params: Omit<RealtimeTTSInput, 'wsUrl' | 'apiKey'>, onFirstFrame?: () => void): Promise<void> {
    const text = toTtsText(params.text); // 易读替换：只改念的字，不影响落库/回看原文
    let lastErr: unknown = null;
    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      let attempt = 0;
      while (true) {
        try {
          const acc: Uint8Array[] = [];
          for await (const pcm of streamTTS({ ...params, text, wsUrl: ep.url, apiKey: ep.key })) {
            if (params.signal?.aborted) break;
            acc.push(pcm);
          }
          if (params.signal?.aborted) return;
          // onStart（标记「已出声」）迁到首帧真正播放时再触发，别在合成阶段就提前亮「对方正在说」。
          for (let j = 0; j < acc.length; j++) {
            this.pushPcm(acc[j], j === 0 ? () => { this.onStart(); onFirstFrame?.(); } : undefined);
          }
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
