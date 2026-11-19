import type { MemoryKind, MemoryStore } from '@mirror/contracts';
import type { Tool } from '../llm/deepseek';

// 「说话 LLM」的按需记忆工具集（已从实时热路径摘除，保留给可选文字/深度模式的定向召回）：
// recall_memory（按需语义检索）+ write_memory（持久化）。定义处即注册处：tools 是给 DeepSeek
// 的 JSON Schema，execute 按 name 分派执行。参考 kima 的 tools.py 但只保留这两个、不做重设施。

const KIND_LABEL: Record<MemoryKind, string> = {
  constraint: '约束',
  fact: '事实',
  preference: '偏好',
  episodic: '情节',
  persona: '人设',
};

export type MemoryToolRuntime = {
  tools: Tool[];
  execute(name: string, argsJson: string): Promise<string>;
};

export function buildMemoryTools(deps: {
  store: MemoryStore;
  classify: (raw: string) => Promise<MemoryKind | null>;
  userId: string;
  characterId: string;
}): MemoryToolRuntime {
  const { store, classify, userId, characterId } = deps;

  const tools: Tool[] = [
    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description:
          '按需检索关于对方的长期记忆。当你想不起对方的某件具体事实/偏好/过往经历时调用；' +
          'query 用一句自然语言描述要找什么，kind 可选（fact/preference/episodic），不填则都搜。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要检索的内容，如「对方最近的工作状态」' },
            kind: { type: 'string', enum: ['fact', 'preference', 'episodic'] },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_memory',
        description:
          '把值得长期记住的内容写进记忆。当对方说出关于自己的稳定事实、反复表达的偏好、或重要事件时调用。' +
          '不要每句话都写，只在确有价值时写。kind 先自报（fact/preference/episodic/persona/constraint），系统会再核对一次。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '用第三人称、一句话概括要记住的内容' },
            kind: { type: 'string', enum: ['constraint', 'fact', 'preference', 'episodic', 'persona'] },
          },
          required: ['content', 'kind'],
        },
      },
    },
  ];

  async function execute(name: string, argsJson: string): Promise<string> {
    const args = safeParse(argsJson);
    if (name === 'recall_memory') {
      const query = String(args.query ?? '').trim();
      if (!query) return '（recall_memory 缺少 query）';
      const kind = (args.kind as MemoryKind) || undefined;
      const hits = await store.search(characterId, userId, query, kind);
      return formatRecall(hits);
    }
    if (name === 'write_memory') {
      const content = String(args.content ?? '').trim();
      const reported = (args.kind as MemoryKind) || 'episodic';
      if (!content) return '（write_memory 缺少 content）';
      // 确定性分类兜底：四型钉回正确桶；分类失败回退信任自报。
      const kind = (await classify(content)) ?? reported;
      const mem = await store.write(characterId, userId, { kind, content });
      return `已记住（${KIND_LABEL[mem.kind]}）：${mem.content}`;
    }
    return `（未知工具 ${name}）`;
  }

  return { tools, execute };
}

function formatRecall(hits: { kind: MemoryKind; content: string }[]): string {
  if (hits.length === 0) return '没有找到相关记忆。';
  return (
    `找到 ${hits.length} 条相关记忆：\n` +
    hits.map((h) => `- [${KIND_LABEL[h.kind]}] ${h.content}`).join('\n')
  );
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(json);
    return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
