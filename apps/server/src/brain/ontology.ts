import type { CoverageEntry } from '@mirror/contracts';

// 好奇心维度本体：从「已知」往「未知」延伸的清单。
// 每个维度都可有可无（不是人人必填）；每个维度下再拆几个「子槽 aspect」——
// 有部分了解时，报「你提到了原生家庭，但还不知道父亲/兄弟姐妹」这类边级延伸。

export type CuriosityDimension = { key: string; hint: string; aspects: string[] };

export const CURIOSITY_DIMENSIONS: CuriosityDimension[] = [
  { key: '原生家庭', hint: '父母、兄弟姐妹、童年、与家人的关系', aspects: ['父亲', '母亲', '兄弟姐妹', '童年', '家庭关系'] },
  { key: '教育', hint: '上过的学校、专业、学习经历', aspects: ['学校', '专业', '学习经历'] },
  { key: '职业', hint: '做什么工作、公司、岗位、职业经历', aspects: ['当前工作', '公司', '岗位', '职业经历'] },
  { key: '关系', hint: '伴侣、朋友、重要的人', aspects: ['伴侣', '朋友', '重要的人'] },
  { key: '爱好', hint: '喜欢做的事、业余爱好', aspects: ['兴趣爱好', '特长'] },
  { key: '重大事件', hint: '转折点、创伤、成就、关键经历', aspects: ['转折点', '创伤', '成就'] },
  { key: '宠物', hint: '养过的宠物', aspects: ['宠物'] },
  { key: '旅行', hint: '去过的地方、旅行经历', aspects: ['去过的地方'] },
  { key: '价值观', hint: '看重什么、人生目标、信念', aspects: ['信念', '人生目标'] },
  { key: '健康', hint: '身体、作息、心理状态', aspects: ['身体', '作息', '心理'] },
  { key: '金钱', hint: '收入、消费、储蓄、理财', aspects: ['消费', '储蓄', '理财', '收入'] },
  { key: '美食', hint: '爱吃什么、做饭、常去的店、家乡味', aspects: ['爱吃', '做饭', '餐厅', '家乡味'] },
  { key: '娱乐', hint: '影视、音乐、读书、游戏', aspects: ['影视', '音乐', '读书', '游戏', '综艺'] },
  { key: '生活日常', hint: '一天怎么过、周末、家务、居住城市', aspects: ['一天', '周末', '家务', '城市'] },
  { key: '自我认知', hint: '性格、优缺点、别人怎么评价', aspects: ['性格', '优缺点', '别人眼中的我'] },
  { key: '梦想', hint: '小时候的梦想、现在想做的事', aspects: ['小时候的梦想', '现在的梦想', '未完成'] },
];

// 给抽取 prompt 用的维度清单（一行中文，用 / 连接）。
export const DIMENSION_LIST = CURIOSITY_DIMENSIONS.map((d) => d.key).join('/');

// 给抽取 prompt 用的「维度 → 子槽」清单（多行）。
export const ASPECT_LIST = CURIOSITY_DIMENSIONS.map((d) => `${d.key}：${d.aspects.join('/')}`).join('；');

// 某维度已知的子槽集合。
function knownAspectsOf(coverage: CoverageEntry[], dimension: string): Set<string> {
  return new Set(
    coverage
      .filter((c) => c.dimension === dimension && c.aspect)
      .map((c) => c.aspect as string),
  );
}

// 某维度已知事实总数（有 aspect 的 + 没 aspect 的）。
function totalCountOf(coverage: CoverageEntry[], dimension: string): number {
  return coverage.filter((c) => c.dimension === dimension).reduce((n, c) => n + c.count, 0);
}

// 生成好奇心线索（软信号），无缺口返回 undefined。分三级降噪：
// ① 完全空白（首次对话）→ 一条精简提示，不 dump 全部维度（16 项是噪音，模型会当没看见）；
// ② 空维度「还不太了解 X」最多列 3 个；③ 部分了解的维度「你提到了 X，但还不知道 a/b」（边级延伸，具体、优先）。
export function buildCuriosityHint(coverage: CoverageEntry[]): string | undefined {
  const totalFacts = coverage.reduce((n, c) => n + c.count, 0);

  // 首次对话：十六个维度全空，别铺一堵清单，给一句可执行的引导即可。
  if (totalFacts === 0) {
    return '[CURIOSITY] 你还不了解对方。对方聊得投入就顺着 TA 聊；当话题快聊尽、或 TA 反问起你时，可以轻轻好奇一句 TA 还没聊过的方面（比如家人、学校、平时爱做什么），一次只问一个，别查户口。';
  }

  const dimGaps = CURIOSITY_DIMENSIONS
    .filter((d) => totalCountOf(coverage, d.key) === 0)
    .map((d) => d.key);

  const aspectGaps: { dim: string; missing: string[] }[] = [];
  for (const d of CURIOSITY_DIMENSIONS) {
    const known = knownAspectsOf(coverage, d.key);
    if (known.size === 0) continue; // 完全空白维度交给 dimGaps 报
    const missing = d.aspects.filter((a) => !known.has(a));
    if (missing.length > 0) aspectGaps.push({ dim: d.key, missing });
  }

  if (dimGaps.length === 0 && aspectGaps.length === 0) return undefined;

  const lines: string[] = [];
  if (dimGaps.length > 0) {
    lines.push(`还不太了解：${dimGaps.slice(0, 3).join('、')}${dimGaps.length > 3 ? ' 等' : ''}`);
  }
  for (const g of aspectGaps) lines.push(`你提到了${g.dim}，但还不知道：${g.missing.join('、')}`);

  return `[CURIOSITY] 好奇心线索（若话题自然带到、可好奇地问一句，别查户口）：\n${lines.map((l) => `- ${l}`).join('\n')}`;
}
