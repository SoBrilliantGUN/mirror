import type { ChatMessage, DeepSeek, Tool, ToolCall } from '../llm/deepseek';

// 结尾「是否等回应」标签：生成时顺带输出 [[AWAITS:1]]（等对方回应/提问）或 [[AWAITS:0]]（纯陈述）。
// 模型漏打标签时 awaits 返回 null，调用方回退正则（/[？?]/）兜底。
const AWAITS_RE = /\[\[AWAITS\s*:\s*([01])\]\]/i;

export function extractAwaits(text: string): { clean: string; awaits: boolean | null } {
  const m = AWAITS_RE.exec(text);
  if (!m) return { clean: text, awaits: null };
  return { clean: text.replace(AWAITS_RE, '').trim(), awaits: m[1] === '1' };
}

const SENTENCE_END = '。！？!?';
const HAS_WORD = /[\p{L}\p{N}]/u;

function findSentenceEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (SENTENCE_END.includes(s[i])) return i + 1;
  }
  return -1;
}

// 流式切句：把字符增量按句末标点切成完整句子，未完成的尾巴留待 flush() 吐出。
// streamMessages / streamMessagesWithTools 共用，消掉两处重复的 buffer + findSentenceEnd 循环。
class SentenceSplitter {
  private buf = '';
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let idx;
    while ((idx = findSentenceEnd(this.buf)) !== -1) {
      const sentence = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx);
      if (sentence && HAS_WORD.test(sentence)) out.push(sentence);
    }
    return out;
  }
  flush(): string {
    const rest = this.buf.trim();
    this.buf = '';
    return rest && HAS_WORD.test(rest) ? rest : '';
  }
}

// 流式出句：LLM 边生成边把「已完成的句子」yield 出去，让 TTS 尽早开跑（砍首字延迟）。
// 剩余的不完整尾巴（可能没有句末标点）在流结束时作为最后一句 yield。
export async function* streamMessages(
  llm: DeepSeek,
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const splitter = new SentenceSplitter();
  for await (const delta of llm.stream(messages, { model, temperature: 0.6 })) {
    for (const sentence of splitter.push(delta)) yield sentence;
  }
  const rest = splitter.flush();
  if (rest) yield rest;
}

// 流式出句（工具使能）：边生成边按句 yield（kind:'sentence'，供 TTS 尽早开跑）；
// 若模型决定调用工具（此时无文本输出），流结束后 yield 一次 kind:'tool_calls' 交给上层。
// 有文本输出说明模型没想搜——不会再 yield tool_calls，避免「先说了半句又回头搜」的双播。
export type GenerateEvent =
  | { kind: 'sentence'; text: string }
  | { kind: 'tool_calls'; calls: ToolCall[] };

export async function* streamMessagesWithTools(
  llm: DeepSeek,
  model: string,
  messages: ChatMessage[],
  tools: Tool[],
): AsyncGenerator<GenerateEvent> {
  const splitter = new SentenceSplitter();
  let calls: ToolCall[] = [];
  let emitted = false;
  for await (const ev of llm.streamWithTools(messages, tools, { model, temperature: 0.6 })) {
    if (ev.type === 'text') {
      for (const sentence of splitter.push(ev.text)) {
        emitted = true;
        yield { kind: 'sentence', text: sentence };
      }
    } else if (ev.type === 'tool_calls') {
      calls = ev.calls;
    }
  }
  const rest = splitter.flush();
  if (rest) {
    emitted = true;
    yield { kind: 'sentence', text: rest };
  }
  if (calls.length && !emitted) yield { kind: 'tool_calls', calls };
}

// 主动发话（开场白 / 静默关怀）：没有用户输入，只靠 system prompt 出一句，返回裸文本。
export async function generateProactiveText(llm: DeepSeek, model: string, system: string): Promise<string> {
  let full = '';
  for await (const delta of llm.stream(
    [
      { role: 'system', content: system },
      { role: 'user', content: '（对方还没说话，你来开口）' },
    ],
    { model, temperature: 0.8 },
  )) {
    full += delta;
  }
  return full.trim();
}
