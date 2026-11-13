// 博查 Web Search API 客户端（Node 内置 fetch，零依赖）。
// 无 key / 请求失败 / 解析异常一律优雅降级返回空数组，不阻断对话主链路。

export type SearchResult = { title: string; url: string; snippet: string };

export type BochaSearchOpts = { apiKey: string; baseUrl: string; count?: number };

// 解析响应 data.webPages.value[]：字段 name/url/snippet（summary 作回退）。
export function parseBochaResult(json: unknown): SearchResult[] {
  if (!json || typeof json !== 'object') return [];
  const data = (json as Record<string, unknown>).data ?? (json as Record<string, unknown>);
  const pages = (data as Record<string, unknown>)?.webPages as
    | { value?: unknown[] }
    | undefined;
  if (!pages || !Array.isArray(pages.value)) return [];
  return pages.value
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return {
        title: String(o.name ?? o.title ?? ''),
        url: String(o.url ?? ''),
        snippet: String(o.snippet ?? o.summary ?? ''),
      };
    })
    .filter((r) => r.title || r.snippet);
}

export async function bochaSearch(query: string, opts: BochaSearchOpts): Promise<SearchResult[]> {
  if (!opts.apiKey) return [];
  const base = opts.baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/web-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ query, count: opts.count ?? 5 }),
    });
    if (!res.ok) return [];
    return parseBochaResult(await res.json());
  } catch (e) {
    console.warn('[search] 博查搜索失败：', e);
    return [];
  }
}
