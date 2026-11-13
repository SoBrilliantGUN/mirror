import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Embedder } from '../llm/embedding';

// 人物详情「渐进式加载」——像 Claude Code 的记忆：详情一条一个文件（认知/经历/偏好，
// frontmatter 的 description = 相关性判据），命中才加载详情。
// 常驻底座（角色卡正文 + 记忆索引）已由 scripts/gen-personas.ts 在构建期烤进 PERSONAS 的 systemPrompt，这里只管按需详情。

export type PersonaDetail = {
  name: string;
  description: string; // 触发钩子：什么时候该想起来（用于相关性判据，像 Claude Code 记忆的 description）
  type: string;        // 认知 | 经历 | 偏好
  content: string;
};

const CHARACTER_DIR = join(process.cwd(), 'character'); // npm start 从仓库根跑，cwd=仓库根

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 读 character/<name>/ 的 认知/经历/偏好 详情；不存在返回 []。
export function loadPersonaDetails(name: string): PersonaDetail[] {
  const dir = join(CHARACTER_DIR, name);
  if (!existsSync(dir)) return [];

  const details: PersonaDetail[] = [];
  for (const type of ['认知', '经历', '偏好']) {
    const sub = join(dir, type);
    if (!existsSync(sub)) continue;
    for (const f of readdirSync(sub).sort()) {
      if (!f.endsWith('.md')) continue;
      details.push(parseDetail(read(join(sub, f)), type));
    }
  }
  return details;
}

// 解析 frontmatter（name / description / type）+ 正文。可单测。
export function parseDetail(raw: string, type: string): PersonaDetail {
  const normalized = raw.replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { name: '', description: '', type, content: normalized.trim() };
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim();
  const description = (fm.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim();
  return { name, description, type, content: m[2].trim() };
}

// 余弦相似度。可单测。
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// 命中详情格式化成一个 [PERSONA] 块（注入 user 消息，供模型当背景用）。可单测。
export function formatPersonaBlock(details: PersonaDetail[]): string {
  if (details.length === 0) return '';
  return '[PERSONA]\n' + details.map((d) => `### ${d.name}（${d.type}）\n${d.content}`).join('\n\n');
}

export type PersonaMatcher = (text: string) => Promise<PersonaDetail[]>;

// 语义匹配器：预计算每条详情 description 的向量（懒加载），命中时对 query 嵌入一次、
// 余弦超阈值即加载——对齐 Claude Code「用 description 决定 recall」。
export function createPersonaMatcher(embedder: Embedder, details: PersonaDetail[], threshold = 0.5): PersonaMatcher {
  let cached: number[][] | null = null;
  const ensure = async (): Promise<number[][]> => {
    if (!cached) cached = await embedder.embed(details.map((d) => d.description || d.name));
    return cached;
  };
  return async (text: string): Promise<PersonaDetail[]> => {
    if (details.length === 0) return [];
    try {
      const vecs = await ensure();
      const [qv] = await embedder.embed([text]);
      return details
        .map((d, i) => ({ d, score: cosine(qv, vecs[i]) }))
        .filter((x) => x.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.d);
    } catch {
      // embedding 未配/失败 → 不加载任何详情（降级，不阻断对话）
      return [];
    }
  };
}
