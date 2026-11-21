// —— L3 情绪 / 状态 / 结果：打分（Affect）→ 判定（Mode/Stance/Emotion）→ 返回（TurnResult）——
//
// 五个都跟「情绪」有关、但语义不同的概念（接手时最容易混，先背这张表）：
//   Affect      = 本轮瞬时三维打分（valence/arousal/dominance + incongruence），一次性，每轮重打
//   MoodState   = Affect 的多轮 EMA 平滑（mood.ts 的 updateMood），是「长期心境轨迹」
//   Mode        = 升/降级开关（casual/careful），由 Affect + 安全旗标硬判定，带防抖（ModeTracker）
//   Stance      = 由支配度驱动的「陪(accompany) vs 引(guide)」姿态
//   EmotionTag  = 喂给 TTS 的「陪伴者这一句的语气」（warm/tender/steady/natural），逐句可再细分
// 另：Frame（friend/coach，见 coach.ts）与 Mode 正交——一个是「交互框架」，一个是「情绪强度」。
import type { SafetyAction, DependenceAction } from './safety';
import type { Frame } from './coach';

// call1 打分输出
export type Affect = {
  valence: number;        // -2..+2：痛苦/厌恶 → 愉悦
  arousal: number;        // -2..+2：麻木/疲惫 → 激动/崩溃
  dominance: number;      // -2..+2：无力/被压着 → 掌控/主动
  incongruence: boolean;  // 文字平静 + 声音异常 = 逞强
};

export type Mode = 'casual' | 'careful';
export type Stance = 'guide' | 'accompany';   // 由支配度驱动：低支配 → 只陪不抛清单

// 表达「陪伴者此刻情绪」的标签（喂给 TTS）
// 4 个方向，由对方情绪驱动（通用镜像），再叠加人设底色 voiceTint。
export type EmotionTag = 'warm' | 'tender' | 'steady' | 'natural';

// —— L3 对外接口返回值 ——
export type TurnResult = {
  affect: Affect;
  mode: Mode;
  stance: Stance;
  emotion: EmotionTag;      // 本轮回应情绪（由对方情绪驱动）
  segmentEmotions?: EmotionTag[]; // 逐句情绪（B2：与 segments 等长，生成后分类；缺省回退 emotion）
  segments: string[];       // 已按句切分
  safetyAction: SafetyAction;      // 危机（自伤/轻生）
  dependence: DependenceAction;    // 过度依赖（话术层设界，不转介）
  frame?: Frame;            // 本轮交互框架（friend/coach，教练改造后新增；缺省回退 friend）
};

// —— 副语言（音频上行，喂给 call1 打分）——
export type AcousticFeatures = {
  rateZ: number;      // 语速 z-score（正 = 偏快）
  pitchZ: number;     // 音高 z-score
  loudnessZ: number;  // 响度 z-score
  pauseZ: number;     // 停顿 z-score（正 = 停顿多）
};

// 非言语发声（哭/笑）：已实现为服务端 `NlsSoundEventDetector`（Node WS 客户端）→ 阿里云 NLS 云端声音事件检测。
export type VocalizationEvent = { type: 'laugh' | 'cry'; at: number; confidence?: number };

// —— 心境（L5）：mood = affect 的多轮 EMA ——
export type MoodState = {
  valence: number;
  arousal: number;
  dominance: number;
};
