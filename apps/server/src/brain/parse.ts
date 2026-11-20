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

// 布尔字段容错：JSON true 或字符串 "true" 都算 true，其余（含 "false"/缺失）都算 false。
// 模型常把布尔写成字符串，各分类器解析统一走这里，避免散落 `o.x === true || o.x === 'true'`。
export function parseBool(v: unknown): boolean {
  return v === true || v === 'true';
}

// 字符串字段：非空字符串返回 trim 后的值，否则 null（供「theme 之类可缺省字段」用）。
export function parseStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// 枚举字段：命中允许值集合则返回该值（收窄类型），否则 null。可单测。
export function parseEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
