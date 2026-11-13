import type { DeepSeek } from '../llm/deepseek';
import { estimateTokens, type HistoryEntry } from './context';

// 上下文压缩（只打 L5 历史），参考 kima 的五级渐进压缩，但适配 companion 极简形态：
// 历史里没有重工具日志，故把 kima 的「TOOL_COMPRESS（工具结果内联压缩）」一级省略，
// 保留 NONE / HISTORY_SUMMARY / TOPIC_SUMMARY / EMERGENCY 四级，按「历史超出预算的倍数」升级。
// 摘要走 LLM（temperature=0），保留最近 N 轮逐字、更早的摘要成带内标记 `[xxx SUMMARY]`。

export type HistorySummarizer = (entries: HistoryEntry[]) => Promise<string>;

export type CompressConfig = {
  historyRecent: number;    // HISTORY 级保留的最近轮数
  topicRecent: number;      // TOPIC 级保留的最近轮数
  emergencyRecent: number;  // EMERGENCY 级保留的最近轮数
};

export const DEFAULT_COMPRESS_CONFIG: CompressConfig = {
  historyRecent: 6,
  topicRecent: 4,
  emergencyRecent: 2,
};

const SUMMARY_SYSTEM = `你是上下文压缩助手。把下面的对话历史压缩成一段简短摘要，保留：对方说的关键事实与情绪变化、你们聊到的主题、以及还没解决的事。用第三人称（对方/我）客观概括，只输出摘要，不要解释。`;

// 历史 token 估算（每条约 +4 协议开销）。
export function estimateHistoryTokens(entries: HistoryEntry[]): number {
  return entries.reduce((n, e) => n + estimateTokens(e.text) + 4, 0);
}

// 历史 → 纯文本（给摘要器读）。
export function historyToText(entries: HistoryEntry[]): string {
  return entries
    .map((e) => (e.kind === 'summary' ? `${e.marker} ${e.text}` : `${e.role === 'user' ? '对方' : '我'}：${e.text}`))
    .join('\n');
}

// 按「历史超出预算的倍数」选压缩级别。可单测。
export function pickLevel(overflow: number): 'none' | 'history' | 'topic' | 'emergency' {
  if (overflow < 1) return 'none';
  if (overflow < 1.5) return 'history';
  if (overflow < 2) return 'topic';
  return 'emergency';
}

// 压缩历史：只压 L5。返回的列表满足「至多一条摘要、恒在最前」的不变量。
export async function compressHistory(
  entries: HistoryEntry[],
  budgetTokens: number,
  summarizer: HistorySummarizer,
  cfg: CompressConfig = DEFAULT_COMPRESS_CONFIG,
): Promise<HistoryEntry[]> {
  const tokens = estimateHistoryTokens(entries);
  if (tokens <= budgetTokens) return entries;

  const level = pickLevel(tokens / budgetTokens);
  const recent = level === 'emergency' ? cfg.emergencyRecent : level === 'topic' ? cfg.topicRecent : cfg.historyRecent;
  const marker = level === 'emergency' ? '[EMERGENCY SUMMARY]' : level === 'topic' ? '[TOPIC SUMMARY]' : '[HISTORY SUMMARY]';

  const kept = entries.slice(-recent);
  const older = entries.slice(0, Math.max(0, entries.length - recent));
  if (older.length === 0) return kept;

  const summary = (await summarizer(older)).trim();
  if (!summary) return kept; // 摘要失败兜底：丢弃中间段
  return [{ kind: 'summary', marker, text: summary }, ...kept];
}

// LLM 摘要器工厂（走 DeepSeek 非流式，temperature=0）。
export function createSummarizer(llm: DeepSeek, model: string): HistorySummarizer {
  return async (entries: HistoryEntry[]): Promise<string> => {
    const text = historyToText(entries);
    const out = await llm.chat(
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: text },
      ],
      { model, temperature: 0, maxTokens: 600 },
    );
    return out.trim();
  };
}
