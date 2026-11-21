import type {
  AcousticFeatures,
  Affect,
  CoachCue,
  DependenceAction,
  DependenceSignals,
  EmotionTag,
  Frame,
  Mode,
  MoodState,
  Persona,
  SafetyAction,
  SafetyGuard,
  Stance,
  TurnResult,
  VocalizationEvent,
} from '@mirror/contracts';
import type { LlmClient } from '../llm/client';
import type { ModeTracker } from './modeTracker';
import type { CoachTracker } from './coach';
import { classifyCoachCue } from './coach';
import { scoreAffect } from './decide';
import { streamMessages } from './generate';
import { buildTurnMessages, emptyRecall } from './assemble';
import { classifySegmentEmotion } from './segmentEmotion';
import { decideEmotion, decideStance, updateMood } from './emotion';
import { classifyFarewell } from './farewell';

export type TurnDeps = {
  llm: LlmClient;
  scoreModel: string;
  generateModel: string;
  safetyGuard: SafetyGuard;
  tracker: ModeTracker;    // 会话级（L5）
  coachTracker: CoachTracker; // 会话级交互框架（friend/coach）
  mood: MoodState | null;  // 会话级（L5），本轮入参，返回最新
};

export type TurnInput = {
  text: string;
  acoustic: AcousticFeatures;
  persona: Persona;
  vocalizations?: VocalizationEvent[]; // 本轮检测到的哭/笑事件（非言语发声）
  dominantVocal?: 'cry' | 'laugh' | null; // 聚合加权后的主导类型（哭/笑区分用）
  dependenceSignals?: DependenceSignals; // L4 过度依赖的行为信号（通话会话记录，可选）
};

// 决策阶段产物：不含正文。正文由调用方用 streamMessages 流式出句（砍首字延迟）。
export type TurnPlan = {
  affect: Affect;
  mode: Mode;
  stance: Stance;
  emotion: EmotionTag;
  safetyAction: SafetyAction;      // 危机（自伤/轻生）
  dependence: DependenceAction;    // 过度依赖
  farewell: boolean;               // 对方这一轮是否在道别（模型判定，替代关键词正则）
  frame: Frame;                    // 本轮交互框架（friend/coach）
  coachCue: CoachCue;              // 本轮教练意图（观测 + 后台课题巩固用）
  coachInvite: boolean;            // 本轮是否注入温柔邀入块（主动察觉）
  celebrate: boolean;              // 本轮是否刚因「解决」退出教练（注入庆祝块）
  mood: MoodState;
};

export type TurnResultWithMood = TurnResult & { mood: MoodState };

// 决策阶段：安全 → 打分 → 判 mode/情绪/stance → 更新心境。
// 不生成正文，让调用方流式出句（砍首字延迟）。
export async function planTurn(deps: TurnDeps, input: TurnInput): Promise<TurnPlan> {
  const { llm, scoreModel, generateModel, safetyGuard, tracker, coachTracker } = deps;

  // L4 安全检测（小模型）+ call1 打分 + 道别判定 + 教练意图并行，不额外吃首字延迟。
  const [safety, affect, farewell, coachCue] = await Promise.all([
    safetyGuard.check(input.text, input.dependenceSignals),
    scoreAffect(llm, scoreModel, {
      text: input.text,
      acoustic: input.acoustic,
      mood: deps.mood,
      vocalizations: input.vocalizations,
    }),
    classifyFarewell(llm, generateModel, input.text),
    classifyCoachCue(llm, generateModel, input.text),
  ]);

  // 判 mode（含防抖）+ 情绪方向（通用镜像）+ stance + 交互框架（frame）
  const mode = tracker.next(affect, safety.crisis);
  const emotion = decideEmotion(affect, input.dominantVocal);
  const stance = decideStance(affect);
  const wasCoach = coachTracker.current === 'coach';
  const frame = coachTracker.next(coachCue);
  const coachInvite = frame === 'friend' && coachTracker.shouldInvite;
  const celebrate = wasCoach && coachCue.resolved;

  // 交互框架切换日志（进入/退出教练模式，含触发原因与课题主题）。
  if (!wasCoach && frame === 'coach') {
    const reason = coachCue.explicit ? '用户明说求助' : '主动察觉·用户接话';
    console.log(`[coach] 进入教练模式（${reason}）${coachCue.theme ? `，课题「${coachCue.theme}」` : ''}`);
  } else if (wasCoach && frame === 'friend') {
    console.log('[coach] 退出教练模式（对方已解决/放下），回到朋友态');
  }

  // 更新心境（写回 L5）
  const mood = updateMood(deps.mood, affect);

  return {
    affect,
    mode,
    stance,
    emotion,
    safetyAction: safety.crisis,
    dependence: safety.dependence,
    farewell,
    frame,
    coachCue,
    coachInvite,
    celebrate,
    mood,
  };
}

// 非流式：一次拿到完整 segments（run-demo / eval 用）。命名加 NonStreaming 以区别于生产热路径 planTurn。
// 与生产共用同一套消息装配（buildTurnMessages）+ 流式出句（streamMessages），只差召回为空、不接 TTS。
export async function runTurnNonStreaming(deps: TurnDeps, input: TurnInput): Promise<TurnResultWithMood> {
  const plan = await planTurn(deps, input);
  const messages = buildTurnMessages(emptyRecall(), 0, {
    text: input.text,
    mode: plan.mode,
    stance: plan.stance,
    emotion: plan.emotion,
    mood: plan.mood,
    turnCount: 1,
    personaSystemPrompt: input.persona.systemPrompt,
    frame: plan.frame,
    coachInvite: plan.coachInvite,
    celebrate: plan.celebrate,
    vocalizations: input.vocalizations,
  });
  const segments: string[] = [];
  for await (const seg of streamMessages(deps.llm, deps.generateModel, messages)) {
    segments.push(seg);
  }
  // 逐句情绪：首句用本轮基调，后续句生成后分类（B2）。
  const segmentEmotions: EmotionTag[] = [];
  for (let i = 0; i < segments.length; i++) {
    segmentEmotions.push(
      i === 0
        ? plan.emotion
        : await classifySegmentEmotion(deps.llm, deps.generateModel, segments[i], plan.emotion),
    );
  }
  return {
    affect: plan.affect,
    mode: plan.mode,
    stance: plan.stance,
    emotion: plan.emotion,
    segmentEmotions,
    segments,
    safetyAction: plan.safetyAction,
    dependence: plan.dependence,
    frame: plan.frame,
    mood: plan.mood,
  };
}
