// 危机资源块（L4 强制转介用）：已核实热线，结构化 + 格式化。
// 注：本版不做「国内危机资源本地化」（按地域/危机类型分层）——那是后续项；
// 这里先把号码从 prompt 字符串里抽成结构化常量，保证确定性注入时不靠 LLM 临场发挥、也便于逐条核实。
export type CrisisResource = { name: string; number: string; note?: string };

export const CRISIS_RESOURCES: CrisisResource[] = [
  { name: '全国心理援助热线', number: '12356', note: '24 小时' },
  { name: '北京心理危机研究与干预中心热线', number: '010-82951332', note: '24 小时' },
  { name: '希望 24 热线', number: '400-161-9995', note: '24 小时；抑郁与自伤防治专线按 2' },
];

// 注入 L3 的确定性资源块（B 层：保证号码必现）。
export function formatCrisisResources(): string {
  const lines = CRISIS_RESOURCES.map((r) => `- ${r.name} ${r.number}（${r.note}）`);
  return [
    '【危机资源（必须逐条给出，号码不得编造或改动）】',
    ...lines,
    '并引导对方此刻先联系身边可信任的人，或尽快去最近的医院急诊。',
  ].join('\n');
}
