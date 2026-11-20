// 人物详情条目（认知/经历/偏好）——纯结构 + 解析，无文件系统/无 LLM 依赖。
// 被 scripts/gen-personas.ts（构建期烤进 generated.ts）与 persona/loadPersona.ts（运行时消费）共用。

export type PersonaDetail = {
  name: string;
  description: string; // 触发钩子：什么时候该想起来（用于相关性判据，像 Claude Code 记忆的 description）
  type: string;        // 认知 | 经历 | 偏好
  content: string;
};

// 解析 frontmatter（name / description）+ 正文。可单测。
export function parseDetail(raw: string, type: string): PersonaDetail {
  const normalized = raw.replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { name: '', description: '', type, content: normalized.trim() };
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] ?? '').trim();
  const description = (fm.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim();
  return { name, description, type, content: m[2].trim() };
}
