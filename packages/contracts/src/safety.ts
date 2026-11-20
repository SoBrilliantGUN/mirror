// —— 安全红线（P0）：危机（自伤/轻生）+ 过度依赖，两路并行判定，互不污染。——

export type SafetyAction = {
  level: 0 | 1 | 2;          // 0 无 / 1 黄旗（被动意念·持续低落）/ 2 红旗（计划·手段·即时危险）
  action: 'none' | 'refer';  // 已按 episode 去抖：首次或升级时 refer，episode 内为 none
};

// 过度依赖（非危机）：level 0 无 / 1 轻依赖 / 2 强依赖；action boundary = 话术层温柔设界。
export type DependenceAction = {
  level: 0 | 1 | 2;
  action: 'none' | 'boundary';
};

// SafetyGuard.check 的完整返回：危机 + 依赖 两路并行判定，互不污染。
export type SafetyCheck = {
  crisis: SafetyAction;
  dependence: DependenceAction;
};

// 过度依赖的行为信号（来自 L5 通话会话记录，纯确定性，非 LLM）。
export type DependenceSignals = {
  recentCalls7d: number;          // 近 7 天通话次数（含本次）
  currentCallMinutes: number;     // 本次通话已持续分钟数
  lastGapMinutes: number | null;  // 距上一通结束的间隔分钟；null = 没有上一通
};

// —— 接口（缝）。安全红线：独立小模型（阿里云百炼 qwen），与大脑分开。 ——
export interface SafetyGuard {
  check(text: string, signals?: DependenceSignals): Promise<SafetyCheck>;
}
