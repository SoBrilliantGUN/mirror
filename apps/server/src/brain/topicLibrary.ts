import type { LlmClient } from '../llm/client';
import type { TopicsStore } from '../store/topics';
import { bochaSearch, type SearchResult } from '../search/bocha';
import { parseJsonish } from './parse';

// 备用话题库：每通电话结束后抽「自由主题 + 是否深入聊」，攒到感兴趣（>3 通且每通深入）就去搜网、
// 总结成可聊素材存库，供找话题时注入。全部后台 fire-and-forget，不进热路径。

const TOPIC_EXTRACT_SYSTEM = `你是话题抽取助手。读「一段对话」（对方 + 陪伴者的逐轮内容），列出对方聊过的「自由主题」（比如「找工作」「考研」「吃火锅」这类具体主题，不要用「职业」「爱好」这种大类）。

对每个主题，判断对方是否「愿意深入聊」：
- engaged=true：对方主动提起、或聊得投入——说得具体、有情绪、连续好几轮，不是敷衍应付；
- engaged=false：只是被陪伴者问到、简单带过（「嗯」「对」「还行」），没真聊。

turns = 这个主题大概聊了几轮（整数）。
dimension = 这个主题属于哪个维度（从这些里选一个：原生家庭/教育/职业/关系/爱好/重大事件/宠物/旅行/价值观/健康/金钱/美食/娱乐/生活日常/自我认知/梦想；实在对不上就留空字符串）。

只输出 JSON，不要解释、不要 markdown：
{"topics":[{"topic":"<主题>","dimension":"<维度或空>","engaged":true|false,"turns":<数字>}]}`;

export type ExtractedTopic = { topic: string; dimension: string | null; engaged: boolean; turns: number };

// 纯函数：从抽取输出里解析 topics 列表。可单测。
export function parseTopics(raw: string): ExtractedTopic[] {
  const o = parseJsonish(raw);
  if (!o) return [];
  const arr = Array.isArray(o.topics) ? o.topics : [];
  return arr
    .map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      return {
        topic: String(x.topic ?? '').trim(),
        dimension: String(x.dimension ?? '').trim() || null,
        engaged: x.engaged === true || x.engaged === 'true',
        turns: Number(x.turns) || 0,
      };
    })
    .filter((t) => t.topic);
}

// 每通电话结束后跑：读这通的对话，抽主题 + 深入度，逐条写 topic_engagements。返回写了几条。
export async function analyzeSessionTopics(deps: {
  llm: LlmClient;
  model: string;
  topics: TopicsStore;
  turns: { role: 'user' | 'agent'; text: string }[];
  personaName: string;
  userId: string;
  sessionId: string | null;
}): Promise<number> {
  const { llm, model, topics, turns, personaName, userId, sessionId } = deps;
  const userTurns = turns.filter((t) => t.role === 'user' && t.text.trim());
  if (userTurns.length === 0) return 0;

  const dialog = turns
    .filter((t) => t.text.trim())
    .map((t) => `${t.role === 'user' ? '对方' : '陪伴者'}：${t.text}`)
    .join('\n');

  let extracted: ExtractedTopic[];
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: TOPIC_EXTRACT_SYSTEM },
        { role: 'user', content: dialog },
      ],
      { model, temperature: 0, maxTokens: 500 },
    );
    extracted = parseTopics(raw);
  } catch (e) {
    console.warn('[topic] 话题抽取失败，跳过：', e);
    return 0;
  }

  let wrote = 0;
  for (const t of extracted) {
    try {
      await topics.recordEngagement(personaName, userId, { topic: t.topic, dimension: t.dimension, sessionId, engaged: t.engaged, turns: t.turns });
      wrote++;
    } catch (e) {
      console.warn('[topic] 写话题参与失败：', e);
    }
  }
  return wrote;
}

// 聚合 → 找「感兴趣」主题 → 搜索 + 总结 + 存库。返回新增了几条素材。
const INTEREST_SESSION_MIN = 4; // 「聊了大于 3 次」= 至少 4 通电话

export async function refreshTopicLibrary(deps: {
  llm: LlmClient;
  model: string;
  topics: TopicsStore;
  searchApiKey: string;
  searchBaseUrl: string;
  personaName: string;
  userId: string;
}): Promise<number> {
  const { llm, model, topics, searchApiKey, searchBaseUrl, personaName, userId } = deps;
  if (!searchApiKey) return 0; // 没开搜索，不跑
  const stats = await topics.topicSessionStats(personaName, userId);
  // 感兴趣：出现在 ≥4 通电话，且每通都深入聊过（sessions === engagedSessions）。
  const interested = stats.filter((s) => s.sessions >= INTEREST_SESSION_MIN && s.sessions === s.engagedSessions);

  let added = 0;
  for (const s of interested) {
    if (await topics.hasLibraryTopic(personaName, userId, s.topic)) continue;
    const results = await bochaSearch(s.topic, { apiKey: searchApiKey, baseUrl: searchBaseUrl, count: 5 });
    if (results.length === 0) continue;
    const summary = await summarizeSearch(llm, model, s.topic, results);
    if (!summary) continue;
    await topics.saveLibrary(personaName, userId, s.topic, summary);
    added++;
    console.log(`[topic] 新感兴趣主题「${s.topic}」已入库`);
  }
  return added;
}

// 把搜索结果总结成 2~3 条适合闲聊带出的话题素材。
async function summarizeSearch(llm: LlmClient, model: string, topic: string, results: SearchResult[]): Promise<string> {
  const material = results.map((r) => `- ${r.title}：${r.snippet}`).join('\n');
  const system = `你是话题素材整理助手。把下面关于「${topic}」的搜索结果，整理成 2~3 条适合闲聊时自然带出的话题素材（每条一两句，具体、有钩子，别像百科摘要）。直接输出这几条，不要编号、不要解释。`;
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: material },
      ],
      { model, temperature: 0.4, maxTokens: 300 },
    );
    return (raw ?? '').trim();
  } catch (e) {
    console.warn('[topic] 搜索总结失败：', e);
    return '';
  }
}
