// 向量/数学小工具：跨模块共用的纯函数放这里（当前只有余弦相似度，之前散在 persona 与 consolidate 各一份）。

// 余弦相似度（两向量同维度）。零向量兜底返回 0（视为不相似）。可单测。
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
