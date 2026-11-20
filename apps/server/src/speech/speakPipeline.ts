import type { EmotionTag } from '@mirror/contracts';
import type { ChatMessage, DeepSeek, ToolCall } from '../llm/deepseek';
import type { GenerationGate } from '../brain/generationGate';
import type { TtsEngine } from './ttsEngine';
import type { Obs } from '../obs/langfuse';
import { extractAwaits, streamMessages, streamMessagesWithTools } from '../brain/generate';
import { classifySegmentEmotion } from '../brain/segmentEmotion';
import { streamTTS } from './cosyvoiceRealtime';
import { buildInstruction, EMOTION_PROSODY, tailHint } from './emotionInstruction';
import { SEARCH_TOOL, pickFiller } from '../brain/search';
import { bochaSearch } from '../search/bocha';

// 「边查边嘟囔」的最短搜索等待：搜索返回太快时也至少停顿这么久，避免突兀。
const MIN_SEARCH_MS = 1500;

// string[] / AsyncIterable 统一成 AsyncIterator，供逐句流水线预取下一句用。
function asyncIterator<T>(segments: AsyncIterable<T> | T[]): AsyncIterator<T> {
  if (Symbol.asyncIterator in (segments as AsyncIterable<T>)) {
    return (segments as AsyncIterable<T>)[Symbol.asyncIterator]();
  }
  const arr = segments as T[];
  let idx = 0;
  return {
    async next(): Promise<IteratorResult<T>> {
      return idx < arr.length ? { value: arr[idx++], done: false } : { value: undefined as T, done: true };
    },
  };
}

export type StreamTurnSpeechDeps = {
  llm: DeepSeek;
  generateModel: string;
  messages: ChatMessage[];
  baseEmotion: EmotionTag; // plan.emotion，本轮回应基调
  voice: string;           // 已解析好的 CosyVoice 音色
  voiceTint: string;       // 人设底色（叠进 instruction）
  rate: number;            // 语速基线（persona.rate ?? 1.0）
  cosyvoiceModel: string;
  dashscopeWsUrl: string;
  dashscopeApiKey: string;
  bochaApiKey: string;
  bochaBaseUrl: string;
  searchEnabled: boolean;
  gate: GenerationGate;
  gen: number;
  signal: AbortSignal;
  tts: TtsEngine;
  pushAgentPcm: (pcm: Uint8Array) => void;
  sleep: (ms: number) => Promise<void>;
  tStart: number;
  obs: Obs;
};

export type StreamTurnSpeechResult = {
  fullText: string;
  awaitsResponse: boolean | null; // [[AWAITS]] 标签；模型漏打则为 null
  firstTokenMs: number;           // 首句开始合成的耗时（从用户说完）
};

// 逐句流水线（respond 的核心，从 session.ts 抽出）：把「决策好的 messages」流式生成 → 按句切 →
// TTS 播放。下一句的「LLM 续写 + 逐句情绪分类」与当前句的 TTS 播放重叠跑，消掉句与句之间的停顿；
// 需要联网时先走一次工具调用（search_web），拿到结果再续写作答。
// 打断 / 挂断时（gate 失效）中途返回部分结果，由调用方判 isCurrent 决定是否落库。
export async function streamTurnSpeech(deps: StreamTurnSpeechDeps): Promise<StreamTurnSpeechResult> {
  const {
    llm, generateModel, messages, baseEmotion, voice, voiceTint, rate,
    cosyvoiceModel, dashscopeWsUrl, dashscopeApiKey,
    bochaApiKey, bochaBaseUrl, searchEnabled,
    gate, gen, signal, tts, pushAgentPcm, sleep, tStart, obs,
  } = deps;

  let awaitsResponse: boolean | null = null;
  let firstTokenMs = 0;

  const speakOne = async (seg: string, i: number, segEmotion: EmotionTag): Promise<string> => {
    const { clean, awaits } = extractAwaits(seg);
    if (awaits !== null) awaitsResponse = awaits;
    if (!clean) return '';
    const segProsody = EMOTION_PROSODY[segEmotion];
    const segRate = Math.round(rate * (segProsody.rate ?? 1.0) * 100) / 100;
    if (i === 0) {
      firstTokenMs = Date.now() - tStart;
      console.log('[latency] 首句开始合成', firstTokenMs, 'ms（从用户说完）');
      obs.score('first-token-ms', firstTokenMs);
    }
    console.log('[TTS] 合成这句：', clean, '情绪：', segEmotion);
    await obs.span('tts', () => tts.synthesize({
      model: cosyvoiceModel,
      voice,
      instruction: buildInstruction(segEmotion, voiceTint) + tailHint(clean),
      text: clean,
      rate: segRate,
      pitch: segProsody.pitch,
      signal,
    }), { text: clean, emotion: segEmotion });
    return clean;
  };

  // 逐句情绪（B2）：非首句走 classifySegmentEmotion，首句用本轮基调。speakSegments 与工具分支共用。
  const classifySeg = (seg: string): Promise<EmotionTag> =>
    classifySegmentEmotion(llm, generateModel, extractAwaits(seg).clean, baseEmotion);

  const speakSegments = async (segments: AsyncIterable<string> | string[]): Promise<string> => {
    const it = asyncIterator(segments);
    let full = '';
    let i = 0;

    const classify = async (seg: string): Promise<{ text: string; emotion: EmotionTag }> => ({
      text: seg,
      emotion: await classifySeg(seg),
    });
    const prefetch = async (): Promise<{ text: string; emotion: EmotionTag } | null> => {
      const n = await it.next();
      return n.done ? null : classify(n.value);
    };

    // 首句零延迟：直接用本轮基调，不跑分类。
    const first = await it.next();
    if (first.done) return '';
    let cur: { text: string; emotion: EmotionTag } | null = { text: first.value, emotion: baseEmotion };
    let nextP: Promise<{ text: string; emotion: EmotionTag } | null> = prefetch();

    while (cur) {
      if (!gate.isCurrent(gen)) break;
      full += await speakOne(cur.text, i, cur.emotion);
      i++;
      cur = await nextP;
      if (cur) nextP = prefetch();
    }
    return full;
  };

  let fullText = '';
  if (!searchEnabled) {
    fullText = await speakSegments(streamMessages(llm, generateModel, messages));
  } else {
    let searchCall: ToolCall | null = null;
    let spoken = '';
    let i = 0;
    for await (const ev of streamMessagesWithTools(llm, generateModel, messages, [SEARCH_TOOL])) {
      if (!gate.isCurrent(gen)) return { fullText, awaitsResponse, firstTokenMs };
      if (ev.kind === 'sentence') {
        const segEmotion = i === 0 ? baseEmotion : await classifySeg(ev.text);
        spoken += await speakOne(ev.text, i, segEmotion);
        i++;
      } else if (ev.kind === 'tool_calls') {
        searchCall = ev.calls.find((c) => c.name === 'search_web') ?? null;
      }
    }
    if (!gate.isCurrent(gen)) return { fullText, awaitsResponse, firstTokenMs };
    if (!searchCall || spoken.trim()) {
      console.log('[search] 本轮未发起搜索（模型直接作答）');
      fullText = spoken;
    } else {
      let query = '';
      try { query = (JSON.parse(searchCall.arguments)?.query as string) ?? ''; } catch { query = ''; }
      console.log('[search] 模型发起联网搜索：', query || '（空 query）');
      for await (const pcm of streamTTS({
        wsUrl: dashscopeWsUrl,
        apiKey: dashscopeApiKey,
        model: cosyvoiceModel,
        voice,
        instruction: buildInstruction('natural', voiceTint),
        text: pickFiller(),
        rate,
        signal,
      })) {
        if (!gate.isCurrent(gen)) break;
        pushAgentPcm(pcm);
      }
      const t0 = Date.now();
      const results = query ? await bochaSearch(query, { apiKey: bochaApiKey, baseUrl: bochaBaseUrl }) : [];
      await sleep(Math.max(0, MIN_SEARCH_MS - (Date.now() - t0)));
      console.log('[search] 搜索返回', results.length, '条');
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: searchCall.id, type: 'function', function: { name: searchCall.name, arguments: searchCall.arguments } }],
      };
      const summary = results.map((r) => `${r.title}\n${r.snippet}`).join('\n\n') || '（没查到）';
      const toolMsg: ChatMessage = {
        role: 'tool',
        tool_call_id: searchCall.id,
        content: `搜索结果（用「哦，我查到了／原来是…」这类自然语气说出来，别生硬复述）：\n${summary}`,
      };
      fullText = await speakSegments(streamMessages(llm, generateModel, [...messages, assistantMsg, toolMsg]));
    }
  }

  return { fullText, awaitsResponse, firstTokenMs };
}
