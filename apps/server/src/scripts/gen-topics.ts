// 一次性生成：给话题树里每个问题上网搜「丰富素材」，写回 JSON（带 generatedAt）。
// 写死后运行时只读、不重搜；「流行/热点」交给已有的「根据兴趣上网搜话题」功能。
// 用法：npx tsx apps/server/src/scripts/gen-topics.ts（需要 BOCHA_API_KEY + DEEPSEEK_API_KEY）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadDotEnv } from '../config';
import { LlmClient } from '../llm/client';
import { bochaSearch, type SearchResult } from '../search/bocha';

const DIMENSIONS = ['原生家庭', '教育', '职业', '关系', '爱好', '重大事件', '宠物', '旅行', '价值观', '健康'];

async function summarize(llm: LlmClient, model: string, question: string, results: SearchResult[]): Promise<string> {
  const material = results.map((r) => `- ${r.title}：${r.snippet}`).join('\n');
  const system = `你是话题素材整理助手。围绕「${question}」这个话题，把下面的搜索结果整理成 2~3 条有趣、可聊的背景素材（每条一两句，具体、有钩子，别像百科摘要）。直接输出这几条，不要编号、不要解释。`;
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
    console.warn('[gen-topics] 总结失败：', e);
    return '';
  }
}

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (!cfg.search.bochaApiKey) {
    console.error('缺少 BOCHA_API_KEY，先配 .env');
    process.exit(1);
  }
  const llm = new LlmClient({ apiKey: cfg.llm.deepseekApiKey, baseUrl: cfg.llm.deepseekBaseUrl });
  const dir = join(process.cwd(), 'apps', 'server', 'src', 'topics');

  let updated = 0;
  for (const dim of DIMENSIONS) {
    const file = join(dir, `${dim}.json`);
    if (!existsSync(file)) { console.warn(`[gen-topics] 缺 ${dim}.json，跳过`); continue; }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      dimension: string;
      aspects: { aspect: string; questions: { text: string; material?: string; generatedAt?: string }[] }[];
    };
    let changed = false;
    for (const aspect of raw.aspects) {
      for (const q of aspect.questions) {
        if (q.material) continue; // 已有素材，跳过
        const results = await bochaSearch(`${dim} ${q.text}`, { apiKey: cfg.search.bochaApiKey, baseUrl: cfg.search.bochaBaseUrl, count: 5 });
        if (results.length === 0) continue;
        const summary = await summarize(llm, cfg.llm.generateModel, q.text, results);
        if (!summary) continue;
        q.material = summary;
        q.generatedAt = new Date().toISOString();
        changed = true;
        updated++;
        console.log(`[gen-topics] ${dim}/${aspect.aspect}：${q.text}`);
      }
    }
    if (changed) writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  }
  console.log(`\n生成完成：共写入 ${updated} 条素材`);
}

main().catch((e) => { console.error(e); process.exit(1); });
