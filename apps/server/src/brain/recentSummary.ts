import type { LlmClient } from '../llm/client';
import { estimateTokens, type HistoryEntry } from './context';
import { historyToText } from './compress';

// 最近对话概要（跨通话）：
// - summarizeCall：通话结束时把这一通的 history 概括成「话题脉络」。
// - mergeCallSummaries：通话前把最近 3 天的多份概要合并；超预算先 LLM 压成一段短回顾再注入。
// 与长期语义记忆（事实/偏好/情节/特质）互补：那个记「稳定事实」，这个记「最近聊了啥」。
// 命名区分：compressHistory（compress.ts，会话内历史压缩）≠ 本文件的「跨通话概要」。

const SUMMARY_SYSTEM = `你是对话概要助手。读下面这段刚结束的通话记录，用第三人称、口语化地概括「这次聊了哪些话题、大致聊了什么」。2~4 句，像回忆一段刚结束的聊天，不要写成事实清单，不要输出解释。`;

const COMPRESS_SYSTEM = `你是对话概要压缩助手。把下面这份「最近几天和对方聊过的话题」压缩成一段更短的口语化回顾，保留主要话题与大致脉络，去掉重复和琐碎。2~4 句，只输出回顾，不要解释。`;

// 最近 3 天概要合并后的预算（token）：超出就压缩成一段短回顾。可调。
const RECENT_BUDGET_TOKENS = 400;

export async function summarizeCall(llm: LlmClient, model: string, history: HistoryEntry[]): Promise<string> {
  const text = historyToText(history);
  if (!text.trim()) return '';
  try {
    const out = await llm.chat(
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: text },
      ],
      { model, temperature: 0, maxTokens: 300 },
    );
    return out.trim();
  } catch (e) {
    console.warn('[summary] 概要生成失败，跳过：', e);
    return '';
  }
}

// 合并多份概要：不超预算则原样按时间顺序拼接，超预算则 LLM 压成一段短回顾。
export async function mergeCallSummaries(llm: LlmClient, model: string, summaries: string[]): Promise<string> {
  const joined = summaries.join('\n');
  if (!joined.trim()) return '';
  if (estimateTokens(joined) <= RECENT_BUDGET_TOKENS) return joined;
  try {
    const out = await llm.chat(
      [
        { role: 'system', content: COMPRESS_SYSTEM },
        { role: 'user', content: joined },
      ],
      { model, temperature: 0, maxTokens: 300 },
    );
    return out.trim() || joined;
  } catch (e) {
    console.warn('[summary] 概要压缩失败，回退原文：', e);
    return joined;
  }
}
