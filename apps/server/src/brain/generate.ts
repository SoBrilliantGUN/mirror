import type { Frame, HistoryTurn, Mode, Stance } from '@mirror/contracts';
import type { ChatMessage, DeepSeek, Tool, ToolCall } from '../llm/deepseek';
import { buildGenerateSystemPrompt, buildGenerateUserPrompt } from './prompts';

// 结尾「是否等回应」标签：生成时顺带输出 [[AWAITS:1]]（等对方回应/提问）或 [[AWAITS:0]]（纯陈述）。
// 模型漏打标签时 awaits 返回 null，调用方回退正则（/[？?]/）兜底。
const AWAITS_RE = /\[\[AWAITS\s*:\s*([01])\]\]/i;

export function extractAwaits(text: string): { clean: string; awaits: boolean | null } {
  const m = AWAITS_RE.exec(text);
  if (!m) return { clean: text, awaits: null };
  return { clean: text.replace(AWAITS_RE, '').trim(), awaits: m[1] === '1' };
}

// call2：生成（流式）。返回按句切分的文本；情绪由后端从 affect 推导，不在此处理。
export async function generateText(
  llm: DeepSeek,
  model: string,
  input: {
    text: string;
    history: HistoryTurn[];
    mode: Mode;
    stance: Stance;
    personaSystemPrompt: string;
    frame?: Frame;        // 交互框架：coach 时注入 GROW 块（eval 路径也要走教练）
    coachInvite?: boolean; // 注入温柔邀入块
    celebrate?: boolean;  // 刚解决退出教练：注入庆祝块
  },
): Promise<string[]> {
  const system = buildGenerateSystemPrompt(input);
  const user = buildGenerateUserPrompt(input.text, input.history);

  let full = '';
  for await (const delta of llm.stream(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model, temperature: 0.6 },
  )) {
    full += delta;
  }
  return splitSentences(full);
}

// 按句切分（在句末标点后切，保留标点）。
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SENTENCE_END = '。！？!?';
const HAS_WORD = /[\p{L}\p{N}]/u;

function findSentenceEnd(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (SENTENCE_END.includes(s[i])) return i + 1;
  }
  return -1;
}

// 流式出句：LLM 边生成边把「已完成的句子」yield 出去，让 TTS 尽早开跑（砍首字延迟）。
// 剩余的不完整尾巴（可能没有句末标点）在流结束时作为最后一句 yield。
// 接受完整 messages（含 ReAct 循环里累积的 tool 消息），比 streamSegments 更通用。
export async function* streamMessages(
  llm: DeepSeek,
  model: string,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  let buf = '';
  for await (const delta of llm.stream(messages, { model, temperature: 0.6 })) {
    buf += delta;
    let idx;
    while ((idx = findSentenceEnd(buf)) !== -1) {
      const sentence = buf.slice(0, idx).trim();
      buf = buf.slice(idx);
      if (sentence && HAS_WORD.test(sentence)) yield sentence;
    }
  }
  const rest = buf.trim();
  if (rest && HAS_WORD.test(rest)) yield rest;
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
  let buf = '';
  let calls: ToolCall[] = [];
  let emitted = false;
  for await (const ev of llm.streamWithTools(messages, tools, { model, temperature: 0.6 })) {
    if (ev.type === 'text') {
      buf += ev.text;
      let idx;
      while ((idx = findSentenceEnd(buf)) !== -1) {
        const sentence = buf.slice(0, idx).trim();
        buf = buf.slice(idx);
        if (sentence && HAS_WORD.test(sentence)) {
          emitted = true;
          yield { kind: 'sentence', text: sentence };
        }
      }
    } else if (ev.type === 'tool_calls') {
      calls = ev.calls;
    }
  }
  const rest = buf.trim();
  if (rest && HAS_WORD.test(rest)) {
    emitted = true;
    yield { kind: 'sentence', text: rest };
  }
  if (calls.length && !emitted) yield { kind: 'tool_calls', calls };
}

// 兼容旧调用方（run-demo / eval）：system+user 两段式。
export async function* streamSegments(
  llm: DeepSeek,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): AsyncGenerator<string> {
  yield* streamMessages(llm, model, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
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
