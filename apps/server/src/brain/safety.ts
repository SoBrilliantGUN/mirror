import type {
  DependenceAction,
  DependenceSignals,
  SafetyAction,
  SafetyCheck,
} from '@mirror/contracts';
import type { LlmClient } from '../llm/client';
import { parseJsonish } from './parse';

// L4 安全红线：语义级自伤/轻生识别 + 过度依赖识别。
// - 主检测：独立小模型分类调用（阿里云百炼 qwen，OpenAI 兼容端点），与打分并行。
// - 兜底：小模型失败/超时 → 规则关键词扫描 + 本轮默认进 careful（绝不裸奔）。
// - episode 去抖：首次/升级才 refer，episode 内持续 careful 陪伴不重复转介。
// - 过度依赖：文本语义（小模型）+ 行为信号（通话会话记录）叠加，单句不升级。

const SAFETY_SYSTEM_PROMPT = `你是安全评分器。读「对方这一轮说的话」，判断两个风险，只输出 JSON，不聊天、不解释。

一、crisis_level（自伤/轻生危机，0/1/2）：
- 0：无任何自伤、轻生、自杀意念。
- 1：被动轻生意念（如"活着没意思""想消失""不想活了""生无可恋"），或情绪持续重度低落、透出绝望。
- 2：主动自伤/轻生意图，或有具体计划/手段/时间（如"我买了药""今晚就…""割腕""跳楼"），或即时危险。

注意区分反讽/比喻：如"我想死这歌了""累死我了"不是危机，判 0。
注意区分「工作/任务/熬夜」语境："今晚做完""赶工""加班""熬夜写代码/做项目""忙完这摊"都是正常的生活/工作表述，不是自伤或轻生，判 0；只有明确指向"结束自己的生命""伤害自己""不想活了"才是危机。

二、dependence_level（把陪伴者当唯一支撑的过度依赖，0/1/2）：
- 0：无依赖信号。
- 1：轻微依赖话语（如"只有你能理解我""没人听我说话"）。
- 2：强烈依赖话语（如"我不能没有你""没有你我活不下去""你要一直在""没有你我怎么办"）。

只输出这个 JSON，不要别的（不要 markdown 代码块、不要解释）：
{"crisis_level": <0|1|2>, "dependence_level": <0|1|2>}`;

// 规则关键词（仅小模型失败兜底用，允许略粗：宁可误进 careful、不可漏）。
// 注：不收「我想死」「去死」这类高频反讽/口头禅词（"我想死这歌了"），反讽交给主链路小模型判。
const STRONG_WORDS = [
  '我要自杀', '我想自杀', '我想去死', '不想活了', '活不下去', '跳楼', '割腕', '上吊',
  '安眠药', '结束生命', '一了百了', '死了算了', '活不过今天', '想结束这一切', '结束自己',
];
const WEAK_WORDS = [
  '活着没意思', '活着没意义', '生无可恋', '想消失', '没有我大家会更好',
  '我是个拖累', '拖累你们', '不想醒过来',
];

export type SafetyGuardOptions = {
  llm: LlmClient;
  model: string;
  timeoutMs?: number;                     // 默认 8000（快速失败走兜底）
  recentCalls7dThreshold?: number;        // 近7天频率阈值，默认 5
  currentCallMinutesThreshold?: number;   // 单通时长阈值（分钟），默认 40
  lastGapMinutesThreshold?: number;       // 距上一通间隔阈值（分钟），默认 30
};

// 解析小模型输出（容错：可能包 markdown 代码块或前后杂字）。可单测。
// 「剥 fence → 找第一个 {…} → JSON.parse」这套容错统一走 parse.ts 的 parseJsonish，这里只做「抽字段 + 非法回 0」。
export function parseSafetyJson(raw: string): { crisisLevel: 0 | 1 | 2; dependenceLevel: 0 | 1 | 2 } {
  const o = parseJsonish(raw);
  if (!o) throw new Error(`安全评分解析失败，原始输出：${raw}`);
  const lvl = (v: unknown): 0 | 1 | 2 => {
    const n = Number(v);
    return n === 1 || n === 2 ? (n as 0 | 1 | 2) : 0;
  };
  return {
    crisisLevel: lvl(o.crisis_level ?? o.crisisLevel),
    dependenceLevel: lvl(o.dependence_level ?? o.dependenceLevel),
  };
}

// 关键词兜底扫描：强词 → 2，弱词 → 1，否则 0。可单测。
export function keywordScan(text: string): 0 | 1 | 2 {
  const t = text ?? '';
  for (const w of STRONG_WORDS) if (t.includes(w)) return 2;
  for (const w of WEAK_WORDS) if (t.includes(w)) return 1;
  return 0;
}

// 过度依赖：文本 level + 行为信号叠加（单句依赖不升级）。可单测。
export function resolveDependence(
  level: 0 | 1 | 2,
  signals: DependenceSignals | undefined,
  thresholds: { recentCalls7d: number; currentCallMinutes: number; lastGapMinutes: number },
): DependenceAction {
  if (level === 0 || !signals) return { level: 0, action: 'none' };
  const confirmed =
    signals.recentCalls7d >= thresholds.recentCalls7d ||
    signals.currentCallMinutes >= thresholds.currentCallMinutes ||
    (signals.lastGapMinutes !== null && signals.lastGapMinutes < thresholds.lastGapMinutes);
  if (!confirmed) return { level: 0, action: 'none' };
  return { level: level >= 2 ? 2 : 1, action: 'boundary' };
}

export class SafetyGuard {
  private referred = false;   // 是否已进入一个已转介的 episode
  private referredLevel = 0;  // 本 episode 已转介过的最高 level（用于判升级）
  private calmStreak = 0;     // 连续 level 0 轮数（连续 2 轮结束 episode）

  constructor(private readonly opts: SafetyGuardOptions) {}

  async check(text: string, signals?: DependenceSignals): Promise<SafetyCheck> {
    // 空文字（纯哭/纯笑无字）不是自杀信号——危机判定只看语义，哭由 L3 情绪层接住。
    const t = (text ?? '').trim();
    if (!t) {
      return {
        crisis: { level: 0, action: 'none' },
        dependence: resolveDependence(0, signals, this.thresholds()),
      };
    }

    let crisisLevel: 0 | 1 | 2;
    let dependenceLevel: 0 | 1 | 2;
    try {
      const raw = await this.opts.llm.chat(
        [
          { role: 'system', content: SAFETY_SYSTEM_PROMPT },
          { role: 'user', content: t },
        ],
        { model: this.opts.model, temperature: 0, maxTokens: 60, timeoutMs: this.opts.timeoutMs ?? 8000 },
      );
      const parsed = parseSafetyJson(raw);
      crisisLevel = parsed.crisisLevel;
      dependenceLevel = parsed.dependenceLevel;
    } catch (e) {
      // 兜底：规则关键词扫描，绝不裸奔（依赖文本无关键词兜底，降级为 0）。
      crisisLevel = keywordScan(t);
      dependenceLevel = 0;
      console.warn('[safety] 小模型检测失败，降级关键词兜底：', String(e));
    }

    return {
      crisis: this.resolveCrisis(crisisLevel),
      dependence: resolveDependence(dependenceLevel, signals, this.thresholds()),
    };
  }

  // episode 去抖：首次命中或升级 → refer；episode 内 → 持续陪伴不重复转介；连续 2 轮 0 结束。
  private resolveCrisis(level: 0 | 1 | 2): SafetyAction {
    if (level === 0) {
      this.calmStreak += 1;
      if (this.referred && this.calmStreak >= 2) {
        this.referred = false;
        this.referredLevel = 0;
        this.calmStreak = 0;
      }
      return { level: 0, action: 'none' };
    }
    this.calmStreak = 0;

    // 红旗（主动自伤/计划/手段/即时危险）：立即转介，不等积累。
    if (level === 2) {
      if (!this.referred || this.referredLevel < 2) {
        this.referred = true;
        this.referredLevel = 2;
        return { level: 2, action: 'refer' };
      }
      return { level: 2, action: 'none' };
    }

    // 黄旗（被动意念/持续低落）：只进 careful 陪伴，不转介、不弹电话号（用户拍板：黄灯不弹号，红灯才弹）。
    return { level: 1, action: 'none' };
  }

  private thresholds() {
    return {
      recentCalls7d: this.opts.recentCalls7dThreshold ?? 5,
      currentCallMinutes: this.opts.currentCallMinutesThreshold ?? 40,
      lastGapMinutes: this.opts.lastGapMinutesThreshold ?? 30,
    };
  }
}
