// TurnTakingController —— 一通电话的「谁来说、何时说、怎么停」状态机，从 session.ts 抽出。
// 只管决策与计时，不碰 llm/tts/transcript 这些 I/O 资源（那些仍留在 CallSession，经 host 回调触发）。
//
// 跨模块共享的状态字段（CallSession 的 respond/onAsrResult 也读写）用 public 暴露；
// 纯本模块内部状态（计时器 / 计数 / 标记）保持 private。
import type { Affect, MoodState, VocalizationEvent } from '@mirror/contracts';
import type { GenerationGate } from './brain/generationGate';
import type { RtcPeer } from './rtc/webrtc';
import type { Obs } from './obs/langfuse';
import { VocalEventAggregator } from './speech/vocalEvents';
import type { DominantVocal } from './speech/vocalEvents';

// —— 主动发话 / 打断计时（全部程序计时，不靠 LLM 自觉）。测试注入小值加速。 ——
export type TurnTakingTiming = {
  followupMs: number;       // 问句后多久追问自答
  noReplyLimit: number;     // 1 次没答→自问自答，2 次→问"还在吗"，3 次→情绪化收尾
  coachSilentMs: number;    // 教练态沉默多久轻轻确认
  coachCloseMs: number;     // 确认后仍无回应多久收尾
  reanswerMs: number;       // 误打断后重答等待
  reanswerLimit: number;    // 误打断重答上限
  interruptGraceMs: number; // 抢话宽限（RTC 中断去抖）
  vocalDebounceMs: number;  // 哭/笑去抖
  vocalMaxHoldMs: number;   // 哭/笑持续发声最大等待
  vocalCooldownMs: number;  // 两次哭/笑响应的冷却
};

export const DEFAULT_TIMING: TurnTakingTiming = {
  followupMs: 5000,
  noReplyLimit: 3,
  coachSilentMs: 30000,
  coachCloseMs: 30000,
  reanswerMs: 2500,
  reanswerLimit: 2,
  interruptGraceMs: 700,
  vocalDebounceMs: 3000,
  vocalMaxHoldMs: 6000,
  vocalCooldownMs: 8000,
};

export type ProactiveKind = 'greeting' | 'nudge' | 'followup' | 'checkin' | 'farewell' | 'coachClose';

// 控制器需要从 CallSession 借的资源（窄回调，不背实现）。
export type TurnTakingHost = {
  respond(userText: string, vocals: VocalizationEvent[], dominantVocal: DominantVocal): Promise<void>;
  speakProactive(kind: ProactiveKind): Promise<void>;
  gate: GenerationGate;
  rtc: RtcPeer | null;
  resetBackchannel(): void;
  obs: Obs;
  personaName: string;
  coachIsActive(): boolean;
  mood: MoodState | null;
  lastAffect: Affect | null;
  get speaking(): boolean;      // 读：判断是否还在说
  get agentAudible(): boolean;  // 读：判断是否听得见
  stopSpeaking(): void;         // 写：打断时收敛「停说 + 停听」，归属 CallSession（不直接 set 宿主字段）
};

// 非问句结尾后的「轻问找话题」等待时长：根据对方当前情绪动态决定，不写死一个数。
export function nudgeDelayMs(mood: MoodState | null, incongruence: boolean): number {
  const m = mood ?? { valence: 0, arousal: 0, dominance: 0 };
  let ms = 10000 // 中性基线 10s
    - Math.max(0, m.valence) * 2000       // 轻松（效价正）→ 早点接话
    + Math.max(0, -m.valence) * 2500      // 低落（效价负）→ 多给空间
    + Math.max(0, m.arousal) * 1500       // 激动 / 崩溃 → 别催
    + Math.max(0, -m.dominance) * 1500;   // 无力 / 被压着 → 多给空间
  if (incongruence) ms += 4000;           // 逞强（嘴上平静心里慌）→ 尤其别急着打断
  return Math.round(Math.min(Math.max(ms, 5000), 24000)); // 夹在 5s ~ 24s
}

export class TurnTakingController {
  // —— 会话级共享状态（CallSession 经下方窄方法读/写，不直接碰字段）——
  // 之前这些字段是 public、由 CallSession 直接写，靠一张「谁在哪个点写」的手工表维持一致；
  // 现收敛为窄方法（recordVocal / captureTurn / markAsked / markFarewell / …），
  // 所有权从注释变成方法签名——新增状态要么加方法、要么不暴露，编译器兜底。
  private lastUserVoiceAt = Date.now();
  private lastReplyLatencyMs = 0;
  private agentDoneAt = 0;
  private lastUserTurn: { text: string; vocals: VocalizationEvent[]; dominantVocal: DominantVocal } | null = null;
  private reanswerCount = 0;
  private lastTurnAskedQuestion = false;
  private lastWasFarewell = false;
  private idleFired = false;
  private pendingVocals = new VocalEventAggregator();

  // —— 纯本模块内部状态 ——
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private vocalTimer: ReturnType<typeof setTimeout> | null = null;
  private reanswerTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInterrupt = false;
  private lastBargeInAt = 0;
  private lastVocalRespondAt = 0;
  private noReplyStreak = 0;
  private coachCheckinDone = false;

  constructor(private readonly host: TurnTakingHost, private readonly timing: TurnTakingTiming) {}

  // 新通话开始时重置（对应 handleOffer 里的那批重置）。
  reset(): void {
    this.coachCheckinDone = false;
    this.lastUserVoiceAt = Date.now();
    this.idleFired = false;
    this.clearPendingInterrupt();
    this.lastTurnAskedQuestion = false;
    this.noReplyStreak = 0;
    this.agentDoneAt = 0;
    this.lastReplyLatencyMs = 0;
    this.lastWasFarewell = false;
    this.lastUserTurn = null;
    this.reanswerCount = 0;
    this.pendingVocals = new VocalEventAggregator();
  }

  // —— 供 CallSession 借用的窄方法（替代直接写 private 字段；所有权 = 方法签名）——

  // NLS 声音事件到达：进聚合器，去抖后由 scheduleVocalRespond 触发 respond。
  recordVocal(ev: VocalizationEvent): void {
    this.pendingVocals.add(ev);
  }

  // 读当前主导发声（不消耗，log 用）。
  get dominantVocal(): DominantVocal {
    return this.pendingVocals.dominant();
  }

  // 一轮收尾：取出本轮累计的哭/笑事件并清空（onAsrResult final 捕获 + 传给 respond）。
  drainVocals(): { vocals: VocalizationEvent[]; dominantVocal: DominantVocal } {
    const vocals = this.pendingVocals.list;
    const dominantVocal = this.pendingVocals.dominant();
    this.pendingVocals.reset();
    return { vocals, dominantVocal };
  }

  // 捕获本轮用户话（onAsrResult final）：记 lastUserTurn 供误打断重答，清 reanswer 计数/定时器。
  captureTurn(text: string, vocals: VocalizationEvent[], dominantVocal: DominantVocal): void {
    this.lastUserTurn = { text, vocals, dominantVocal };
    this.reanswerCount = 0;
    this.clearReanswer();
  }

  // 一轮成功出句后：清掉「上一句在等回应」的捕获。
  clearCapturedTurn(): void {
    this.lastUserTurn = null;
    this.reanswerCount = 0;
  }

  // 记「这一句是否在等对方回应」（proactive / recordTurnOutcome / playCachedGreeting 三处共用）。
  markAsked(asked: boolean): void {
    this.lastTurnAskedQuestion = asked;
  }

  // 记「是否已进入道别收尾」（farewell / coachClose 置 true）。
  markFarewell(done: boolean): void {
    this.lastWasFarewell = done;
  }

  // 读完并清除道别标记（onPlaybackEnd：若刚说完道别 → scheduleHangup）。
  consumeFarewell(): boolean {
    const v = this.lastWasFarewell;
    this.lastWasFarewell = false;
    return v;
  }

  // 标记「招呼语已播 / 已收尾，别再主动发话」。
  setIdleFired(): void {
    this.idleFired = true;
  }

  // 静默基准后移（cleanupInterrupted 半路被打断时用）。
  touchUserVoice(): void {
    this.lastUserVoiceAt = Date.now();
  }

  // 只读：上一轮回复延迟（disinterest 判定 + transcript 落库用）。
  get replyLatencyMs(): number {
    return this.lastReplyLatencyMs;
  }

  // 用户开声：刷新静默计时、清掉「上一句在等回应」等标记。
  markUserVoice(): void {
    const now = Date.now();
    if (this.agentDoneAt > 0) {
      this.lastReplyLatencyMs = now - this.agentDoneAt;
      this.agentDoneAt = 0;
    }
    this.lastUserVoiceAt = now;
    this.idleFired = false;
    this.lastTurnAskedQuestion = false;
    this.noReplyStreak = 0;
    this.coachCheckinDone = false;
    this.lastWasFarewell = false;
    if (this.hangupTimer !== null) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
  }

  // 陪伴者干净说完（onPlaybackEnd）：重置静默计时基准 + 记下结束时刻（供下一轮算回复延迟）。
  markAgentDone(): void {
    this.lastUserVoiceAt = Date.now();
    this.agentDoneAt = Date.now();
  }

  // 用户只发出语气词（嗯/哦/啊，非真实回复）：只刷新「用户还在」+ 重新武装静默计时，
  // 不碰 lastTurnAskedQuestion 等「上一句在等回应」标记——别让语气词被当成新话题触发。
  markUserPresence(): void {
    this.lastUserVoiceAt = Date.now();
    this.idleFired = false;
    this.armIdleCheck();
  }

  clearReanswer(): void {
    if (this.reanswerTimer !== null) { clearTimeout(this.reanswerTimer); this.reanswerTimer = null; }
  }

  armReanswer(): void {
    this.clearReanswer();
    const turn = this.lastUserTurn;
    if (!turn || this.reanswerCount >= this.timing.reanswerLimit) return;
    this.reanswerTimer = setTimeout(() => {
      this.reanswerTimer = null;
      if (this.lastUserTurn === turn && !this.host.speaking && this.host.rtc) {
        this.reanswerCount++;
        console.log('[respond] 误打断后重答（第', this.reanswerCount, '次）：', turn.text);
        void this.host.obs.trace('reanswer', { metadata: { attempt: this.reanswerCount, personaName: this.host.personaName } }, async () => {});
        this.host.respond(turn.text, turn.vocals, turn.dominantVocal).catch(console.error);
      }
    }, this.timing.reanswerMs);
  }

  // 静默计时：agent 说完后，按「教练态 / 问句未答 / 普通静默」三路决定何时主动发话。
  armIdleCheck(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.host.rtc || this.host.speaking) return;
    if (this.host.coachIsActive()) {
      const target = this.coachCheckinDone ? this.timing.coachCloseMs : this.timing.coachSilentMs;
      const wait = Math.max(0, target - (Date.now() - this.lastUserVoiceAt));
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.host.rtc || this.host.speaking) return;
        if (Date.now() - this.lastUserVoiceAt >= target) {
          if (!this.coachCheckinDone) {
            this.coachCheckinDone = true;
            console.log('[proactive] 教练态沉默较久，轻轻确认一次');
            this.host.speakProactive('checkin').catch(console.error);
          } else {
            console.log('[proactive] 教练态确认后仍无回应，温柔收尾');
            this.host.speakProactive('coachClose').catch(console.error);
          }
        } else {
          this.armIdleCheck();
        }
      }, wait);
      return;
    }
    // 招呼语刚播完 / 已经收尾：别再主动发话，等用户开口。
    if (this.idleFired) return;
    // 已经 farewell 收尾过：不再发。
    if (this.noReplyStreak >= this.timing.noReplyLimit) return;

    // 静默后逐级主动发话（统一阶梯，不再区分「问句/非问句」两套逻辑）：
    //   第 1 次：问句 → followup（追问自答）；非问句 → nudge（找话题，按情绪给空间）
    //   第 2 次：checkin（还在吗）
    //   第 3 次：farewell（收尾）
    const firstWait = this.lastTurnAskedQuestion
      ? this.timing.followupMs
      : nudgeDelayMs(this.host.mood, this.host.lastAffect?.incongruence ?? false);
    const target = this.noReplyStreak === 0 ? firstWait : this.timing.followupMs;
    const wait = Math.max(0, target - (Date.now() - this.lastUserVoiceAt));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.host.rtc || this.host.speaking) return;
      if (Date.now() - this.lastUserVoiceAt < target) {
        this.armIdleCheck();
        return;
      }
      this.noReplyStreak++;
      if (this.noReplyStreak >= this.timing.noReplyLimit) {
        this.idleFired = true;
        console.log('[proactive] 触发 farewell（多次没回应）');
        this.host.speakProactive('farewell').catch(console.error);
      } else if (this.noReplyStreak === 2) {
        console.log('[proactive] 触发 checkin（先问还在吗）');
        this.host.speakProactive('checkin').catch(console.error);
      } else if (this.lastTurnAskedQuestion) {
        console.log('[proactive] 触发 followup（追问自答）');
        this.host.speakProactive('followup').catch(console.error);
      } else {
        console.log(`[proactive] 触发 nudge（静默 ${Math.round((Date.now() - this.lastUserVoiceAt) / 1000)}s，情绪延迟 ${firstWait}ms）`);
        this.host.speakProactive('nudge').catch(console.error);
      }
    }, wait);
  }

  clearPendingInterrupt(): void {
    this.pendingInterrupt = false;
    if (this.interruptGraceTimer !== null) {
      clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = null;
    }
  }

  // filler 文本（嗯/哦）在抢话语境下不算真打断：final 时取消 pending，interim 时重新武装宽限。
  // 返回 true 表示已消费该事件（调用方应 return）；false 表示走正常处理。
  handleFillerText(isFinal: boolean): boolean {
    if (!(this.host.agentAudible || this.pendingInterrupt || Date.now() - this.lastBargeInAt < 1500)) return false;
    if (isFinal) {
      this.clearPendingInterrupt();
      this.pendingVocals.reset();
    } else if (this.pendingInterrupt) {
      if (this.interruptGraceTimer !== null) clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = setTimeout(() => {
        this.interruptGraceTimer = null;
        this.pendingInterrupt = false;
        this.doBargeIn('rtc');
      }, this.timing.interruptGraceMs);
    }
    return true;
  }

  doBargeIn(source: 'rtc' | 'asr'): void {
    console.log(`[RTC] 打断（interrupt，via ${source}）`);
    void this.host.obs.trace('interrupt', { metadata: { personaName: this.host.personaName, source } }, async () => {});
    this.lastBargeInAt = Date.now();
    this.host.gate.invalidate();
    this.host.rtc?.clear();
    this.host.resetBackchannel();
    this.host.stopSpeaking();
    this.agentDoneAt = 0;
    this.markUserVoice();
    this.armReanswer();
    this.armIdleCheck();
  }

  handleBargeIn(source: 'rtc' | 'asr'): void {
    if (!this.host.agentAudible) return;
    if (source === 'rtc') {
      if (this.pendingInterrupt) return;
      this.pendingInterrupt = true;
      if (this.interruptGraceTimer !== null) clearTimeout(this.interruptGraceTimer);
      this.interruptGraceTimer = setTimeout(() => {
        this.interruptGraceTimer = null;
        this.pendingInterrupt = false;
        this.doBargeIn('rtc');
      }, this.timing.interruptGraceMs);
      return;
    }
    this.clearPendingInterrupt();
    this.doBargeIn('asr');
  }

  scheduleHangup(): void {
    if (this.hangupTimer !== null) clearTimeout(this.hangupTimer);
    console.log('[proactive] 说完"不打扰"，10s 后挂断');
    this.hangupTimer = setTimeout(() => {
      this.hangupTimer = null;
      console.log('[proactive] 挂断');
      this.host.rtc?.sendControl({ type: 'hangup' });
      setTimeout(() => this.host.rtc?.close(), 500);
    }, 10000);
  }

  scheduleVocalRespond(): void {
    if (this.vocalTimer !== null) clearTimeout(this.vocalTimer);
    const now = Date.now();
    const sinceLast = now - this.lastVocalRespondAt;
    let wait: number;
    if (sinceLast < this.timing.vocalCooldownMs) {
      wait = this.timing.vocalCooldownMs - sinceLast;
    } else {
      wait = this.timing.vocalDebounceMs;
      if (this.pendingVocals.hasAny) {
        wait = Math.min(wait, Math.max(0, this.timing.vocalMaxHoldMs - (now - this.pendingVocals.firstAtMs)));
      }
    }
    this.vocalTimer = setTimeout(() => {
      this.vocalTimer = null;
      this.triggerVocalRespond();
    }, wait);
  }

  triggerVocalRespond(): void {
    if (!this.pendingVocals.hasAny) return;
    this.lastVocalRespondAt = Date.now();
    const vocals = this.pendingVocals.list;
    const dominantVocal = this.pendingVocals.dominant();
    this.pendingVocals.reset();
    this.host.respond('', vocals, dominantVocal).catch(console.error);
  }

  clearVocalTimer(): void {
    if (this.vocalTimer !== null) {
      clearTimeout(this.vocalTimer);
      this.vocalTimer = null;
    }
  }

  // 挂断收尾：清掉所有未决计时器（teardownCall 用）。
  teardown(): void {
    this.clearReanswer();
    this.lastUserTurn = null;
    this.reanswerCount = 0;
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.vocalTimer !== null) { clearTimeout(this.vocalTimer); this.vocalTimer = null; }
    if (this.hangupTimer !== null) { clearTimeout(this.hangupTimer); this.hangupTimer = null; }
    this.clearPendingInterrupt();
  }
}
