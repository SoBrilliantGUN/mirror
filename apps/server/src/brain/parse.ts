// LLM 输出里安全抽出 JSON 对象：剥 markdown 围栏 → 找第一个 {…} → JSON.parse。
// 失败返回 null（由各调用方决定自己的兜底），把「容错策略」收敛到这一处。
// 注意：只返回对象（非数组/标量）；需要数组的调用方自己在对象字段里取（如 o.memories）。
export function parseJsonish(raw: string): Record<string, unknown> | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const inner = fence ? fence[1].trim() : raw;
  const brace = inner.match(/\{[\s\S]*\}/);
  const text = brace ? brace[0] : inner;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
