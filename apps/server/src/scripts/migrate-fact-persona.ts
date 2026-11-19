// 一次性存量迁移：把「事实」桶里误存的强相关身份信息迁到「人设」，再做一轮做梦巩固（合并近重复 + 清矛盾 + 抽象升级）。
// 用法：npx tsx apps/server/src/scripts/migrate-fact-persona.ts [persona名]
//   不带参数 = 遍历所有上线 persona（没数据的自动跳过）；带参数 = 只迁那一位。
// 只软删除（superseded），可审计不硬删。
import { loadDotEnv, loadConfig } from '../config';
import { createPool, ensureSchema } from '../store/db';
import { DeepSeek } from '../llm/deepseek';
import { createEmbedder } from '../llm/embedding';
import { createMemoryStore } from '../store/memory';
import { dreamOnMemory } from '../brain/dream';
import { PERSONAS } from '../persona';
import type { Memory, MemoryKind } from '@mirror/contracts';

// 判断哪些 fact 其实是「强相关身份/稳定特质」，该迁到 persona。批量一次判定，省 LLM 调用。
const CLASSIFY_PROMPT = `你是记忆清理助手。下面是一份「关于对方的 fact」记忆列表（每条一个编号）。fact 本应只存「弱相关的可变事实 / 当前状态」（正在经历的事、近期进展、会过时的状态），而「强相关的身份信息与稳定特质」（名字/性别/年龄/职业/学校/地域/重要关系/称呼/性格/价值观）应该归到 persona。

请找出这些 fact 里「其实是强相关身份或稳定特质、该迁到 persona」的条目，输出它们的编号。判断标准：
- 身份/学校/地域/称呼/重要关系（如「对方是深圳大学学生」「对方是广东人」「对方自称章鱼哥」「对方有女友」）→ 该迁 persona
- 稳定特质/性格/长期模式（如「对方性格安静，不太掺和热闹」「对方认为人最重要的是内心认可」）→ 该迁 persona
- 可变状态 / 正在经历的事（如「正在备考」「目前没工作」「正在投简历」「计划刷题」「下周三有面试」）→ 留在 fact

只输出 JSON，不要解释：{"moveToPersona": [<编号数字>]}`;

function parseMoveToPersona(raw: string, total: number): Set<number> {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : raw;
  const brace = jsonStr.match(/\{[\s\S]*\}/);
  let obj: unknown;
  try {
    obj = JSON.parse(brace ? brace[0] : jsonStr);
  } catch {
    return new Set();
  }
  const arr = Array.isArray((obj as Record<string, unknown>).moveToPersona)
    ? ((obj as Record<string, unknown>).moveToPersona as unknown[])
    : [];
  const idx = new Set(arr.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= total));
  return idx;
}

const KINDS: MemoryKind[] = ['constraint', 'fact', 'preference', 'episodic', 'persona'];

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  await ensureSchema(pool);
  const llm = new DeepSeek({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl });
  const embedder = createEmbedder({ apiKey: cfg.embeddingApiKey, baseUrl: cfg.embeddingBaseUrl, model: cfg.embeddingModel });
  const memory = createMemoryStore(pool, embedder, { recallTopK: cfg.memoryRecallTopK });
  const userId = 'demo-user';

  const targets = process.argv[2]
    ? [process.argv[2]]
    : Object.values(PERSONAS).filter((p) => p.available).map((p) => p.name);

  for (const characterId of targets) {
    const snapshot = async (label: string) => {
      const counts: Record<string, number> = {};
      for (const k of KINDS) counts[k] = (await memory.listAll(characterId, userId, { kind: k })).length;
      console.log(`[${characterId}][${label}] 活跃条数 = ${JSON.stringify(counts)}`);
    };

    await snapshot('BEFORE');
    const facts = await memory.listAll(characterId, userId, { kind: 'fact' });
    if (facts.length === 0) {
      console.log(`[${characterId}] 无 fact，跳过\n`);
      continue;
    }

    // 1) 重分类：fact → persona（强相关身份/稳定特质）
    const numbered = facts.map((f, i) => `${i + 1}. ${f.content}`).join('\n');
    const raw = await llm.chat(
      [
        { role: 'system', content: CLASSIFY_PROMPT },
        { role: 'user', content: numbered },
      ],
      { model: cfg.generateModel, temperature: 0, maxTokens: 500 },
    );
    const toMoveIdx = parseMoveToPersona(raw, facts.length);
    let moved = 0;
    for (const i of toMoveIdx) {
      const f = facts[i - 1];
      if (!f) continue;
      try {
        // write(kind='persona') 自带近义去重（0.9）：命中已有 persona 就并入、不新建；再归档旧 fact。
        await memory.write(characterId, userId, { kind: 'persona', content: f.content });
        await memory.remove(characterId, userId, f.id);
        moved++;
        console.log(`  [move] fact → persona：${f.content}`);
      } catch (e) {
        console.warn(`  [move][失败] ${f.content}：`, e);
      }
    }
    console.log(`[${characterId}] fact→persona 迁移 ${moved} 条（判定 ${toMoveIdx.size} 条）`);

    // 2) 做梦巩固：合并近重复 + 清矛盾 + 抽象升级（复用 dreamOnMemory，阈值已调 0.9）
    const r = await dreamOnMemory({ llm, model: cfg.generateModel, store: memory, embedder, userId, characterId });
    console.log(`[${characterId}][dream] 抽象 fact=${r.abstractedFacts} persona=${r.abstractedPersona} | 合并=${r.merged} | 清矛盾=${r.resolved}`);

    await snapshot('AFTER');
    console.log('');
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
