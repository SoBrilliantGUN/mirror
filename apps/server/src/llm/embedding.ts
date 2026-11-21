// 阿里云百炼 embedding 客户端（OpenAI 兼容 /embeddings 端点）。零依赖，Node 内置 fetch。

export type Embedder = {
  // 批量向量化，返回与输入一一对应的向量（顺序保证对齐）。空输入返回空数组。
  embed(texts: string[]): Promise<number[][]>;
};

// 百炼 /embeddings 单次请求 batch 上限 10，超了会报「batch size is invalid」。这里按 10 切片、
// 多次请求后按序拼回，调用方（含做梦合并去重那种几十条一组的场景）无需关心上限。
const EMBED_BATCH = 10;

export function createEmbedder(cfg: { apiKey: string; baseUrl: string; model: string }): Embedder {
  const embedOne = async (texts: string[]): Promise<number[][]> => {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embedding failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  };

  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        out.push(...(await embedOne(texts.slice(i, i + EMBED_BATCH))));
      }
      return out;
    },
  };
}
