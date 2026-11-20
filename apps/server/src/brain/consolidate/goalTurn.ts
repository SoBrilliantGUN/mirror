import type { GrowthGoalStore, GrowthStage } from '@mirror/contracts';
import type { DeepSeek } from '../../llm/deepseek';
import { parseJsonish } from '../parse';

// 后台课题巩固（异步、不进热路径）：教练轮结束后，把「这轮聊的课题」结构化落进 growth_goals。
// 只更新 GROW 四段 + 推进 stage + 检测做成/放下，其余交给 [GOAL] 块 + 模型做轻表达。
// 参考 consolidateTurn 的「后台写、best-effort、失败只告警」模式。

const CONSOLIDATE_GOAL_SYSTEM_PROMPT = `你是成长课题巩固助手。读「对方这一轮 + 陪伴者这一轮」，更新对方的「成长课题」档案。只输出 JSON，不聊天、不解释。

对方正在做的成长课题走 GROW（目标 Goal / 现状 Reality / 选项 Options / 行动 Will），你要把「有进展」的部分结构化记下来。

输出规则：
- title：这条课题的短名（如「和妈妈的边界」「换工作」）。若这轮在聊一个明确的新课题，给新名；在延续旧课题，用旧名（见【已有课题】）；若这轮只是闲聊/情绪倾诉、没有明确课题，title 给 null，其余字段全省略。
- goal / reality / options / will：这轮对方新说出的、对应 GROW 某一段的内容，一句话、第三人称（如「她希望和妈妈好好说话又不委屈自己」）。没新内容就省略该字段。
- stage：这轮推进到了 GROW 的哪一步（goal / reality / options / will），没推进就省略。
- done：对方明确做成了这个课题（「我做到了」「终于成了」），才给 true，否则省略。
- archive：对方明确说不想再管这个了（「算了，随它去」），才给 true，否则省略。

宁缺毋滥：纯闲聊、纯情绪倾诉、没有明确课题进展时，title 给 null。

只输出这个 JSON：
{"title":"<短名或null>","goal":"<或省略>","reality":"<或省略>","options":"<或省略>","will":"<或省略>","stage":"<goal|reality|options|will 或省略>","done":<true|false 或省略>,"archive":<true|false 或省略>}`;

export type GoalExtract = {
  title: string | null;
  goal: string | null;
  reality: string | null;
  options: string | null;
  will: string | null;
  stage: GrowthStage | null;
  done: boolean;
  archive: boolean;
};

const STAGES = new Set<GrowthStage>(['goal', 'reality', 'options', 'will']);

// 纯函数：从模型输出里解析课题进展，非法/缺失回退空。可单测。
export function parseGoalExtract(raw: string): GoalExtract {
  const o = parseJsonish(raw);
  if (!o) return empty();
  const str = (k: string): string | null => {
    const v = o[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const stage = STAGES.has(o.stage as GrowthStage) ? (o.stage as GrowthStage) : null;
  return {
    title: str('title'),
    goal: str('goal'),
    reality: str('reality'),
    options: str('options'),
    will: str('will'),
    stage,
    done: o.done === true || o.done === 'true',
    archive: o.archive === true || o.archive === 'true',
  };
}

function empty(): GoalExtract {
  return { title: null, goal: null, reality: null, options: null, will: null, stage: null, done: false, archive: false };
}

// 兜底推导 stage：模型没给 stage 时，按 G→R→O→W 取「最远已填」的那一段。可单测。
export function deriveStage(g: GoalExtract): GrowthStage | null {
  if (g.stage) return g.stage;
  if (g.will) return 'will';
  if (g.options) return 'options';
  if (g.reality) return 'reality';
  if (g.goal) return 'goal';
  return null;
}

export async function consolidateGoal(deps: {
  llm: DeepSeek;
  model: string;
  store: GrowthGoalStore;
  userId: string;
  characterId: string;
  userText: string;
  agentText: string;
}): Promise<{ updated: number }> {
  const { llm, model, store, userId, characterId, userText, agentText } = deps;
  if (!userText.trim()) return { updated: 0 };

  let out: GoalExtract;
  try {
    const existing = await store.listActive(characterId, userId);
    const raw = await llm.chat(
      [
        { role: 'system', content: CONSOLIDATE_GOAL_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            '【已有课题】' + (existing.map((g) => g.title).join('、') || '（无）') +
            '\n【对方这一轮】' + userText +
            '\n【我这一轮】' + (agentText || '（无）'),
        },
      ],
      { model, temperature: 0, maxTokens: 300 },
    );
    out = parseGoalExtract(raw);
  } catch (e) {
    console.warn('[goal] 课题巩固调用失败，跳过：', e);
    return { updated: 0 };
  }

  if (!out.title) return { updated: 0 }; // 这轮没有明确课题进展

  try {
    const goal = await store.create(characterId, userId, { title: out.title });
    const stage = deriveStage(out);
    const patch: Parameters<GrowthGoalStore['update']>[3] = {};
    if (out.goal) patch.goal = out.goal;
    if (out.reality) patch.reality = out.reality;
    if (out.options) patch.options = out.options;
    if (out.will) patch.will = out.will;
    if (stage) patch.stage = stage;
    if (Object.keys(patch).length > 0) {
      await store.update(characterId, userId, goal.id, patch);
    }
    if (out.done) {
      await store.complete(characterId, userId, goal.id);
      console.log(`[goal] 课题「${goal.title}」做成，庆祝收尾`);
    } else if (out.archive) {
      await store.archive(characterId, userId, goal.id);
      console.log(`[goal] 课题「${goal.title}」归档（对方放下）`);
    } else {
      await store.touch(characterId, userId, goal.id); // 本轮又聊到它，刷新问责节奏
    }
    return { updated: 1 };
  } catch (e) {
    console.warn('[goal] 课题写入失败：', e);
    return { updated: 0 };
  }
}
