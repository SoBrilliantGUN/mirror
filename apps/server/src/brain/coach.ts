import type { CoachCue, Frame } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';

// 教练意图检测 + 交互框架状态机（Life Coach 改造的「显」这一半）。
// - classifyCoachCue：每轮用 LLM 判「对方是不是在求助 / 卡点 / 已解决」——仿 classifyFarewell，确定性输出，可并行。
// - CoachTracker：会话级 frame 状态机（friend ⇄ coach），仿 ModeTracker，纯逻辑可单测。
// 触发（产品定的）：① 用户明说（explicit）→ 立即进教练；② 主动察觉（invite 累计）→ 温柔邀入。
// 退出：用户明确「做成了/解决了/放下了」（resolved）→ 退回朋友，庆祝收口。

const COACH_CUE_SYSTEM_PROMPT = `你是教练意图判定器。读「对方这一轮的话」，判断对方是在求助、透露出反复的成长卡点、还是已经解决了。只输出 JSON，不聊天、不解释。

explicit = true：对方明确在求助或想要指引/方向——「我该怎么办」「我到底想要什么」「我不知道怎么办」「我好迷茫」「帮我分析分析」「我该不该…」这类「要答案、要指引」的话。

invite = true：对方这一轮透露出一个反复的成长卡点/困境（情绪反复低落、反复说累/迷茫、陷在某个纠结里走不出来、持续的自我怀疑），值得温柔邀入教练——但还没明确说「帮我」。注意：单纯抱怨今天累、单纯分享一次难过不算；要「卡住、反复、走不出来」的味道才判 true。

resolved = true：对方明确表示这件事做成了 / 解决了 / 放下了 / 想通了——「我做到了」「终于解决了」「事情办成了」「我想通了，不想了」「算了，随它去」。用于「教练态结束、退回朋友」。
注意：单纯说「今天心情好点了」「比昨天强了」这种「情绪好转」不算 resolved（课题可能还没真正解决）；只有「这件事有了结果 / 放下了」才判 true。

explicit / invite / resolved 可同时为 false（普通闲聊、情绪倾诉、分享日常）。

theme：若这轮能看出对方卡在什么事上（比如「和妈妈的关系」「换工作」「不知道自己想要什么」），用一个短词组概括；看不出就输出 null。

宁缺毋滥：拿不准就 false，别把普通倾诉误判成要教练。

只输出这个 JSON（不要 markdown 代码块、不要解释）：
{"explicit": true|false, "invite": true|false, "resolved": true|false, "theme": "<短词组或 null>"}`;

// 纯函数：从模型输出里抽 { explicit, invite, resolved, theme }，非法/缺失回退全 false、theme null。可单测。
export function parseCoachCue(raw: string): CoachCue {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fence ? fence[1].trim() : raw;
  const brace = jsonStr.match(/\{[\s\S]*\}/);
  let obj: unknown;
  try {
    obj = JSON.parse(brace ? brace[0] : jsonStr);
  } catch {
    return { explicit: false, invite: false, resolved: false, theme: null };
  }
  const o = obj as Record<string, unknown>;
  const theme = typeof o.theme === 'string' && o.theme.trim() ? o.theme.trim() : null;
  return {
    explicit: o.explicit === true || o.explicit === 'true',
    invite: o.invite === true || o.invite === 'true',
    resolved: o.resolved === true || o.resolved === 'true',
    theme,
  };
}

export async function classifyCoachCue(llm: DeepSeek, model: string, text: string): Promise<CoachCue> {
  if (!text.trim()) return { explicit: false, invite: false, resolved: false, theme: null }; // 纯哭/纯笑无字
  try {
    const out = await llm.chat(
      [
        { role: 'system', content: COACH_CUE_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      { model, temperature: 0, maxTokens: 80 },
    );
    return parseCoachCue(out);
  } catch {
    // 分类失败 → 保守回退「不触发」，宁可不进教练也不误切。
    return { explicit: false, invite: false, resolved: false, theme: null };
  }
}

// 主动察觉的累计阈值：连续 invite ≥ 2 才邀入（防把「偶尔累」当成课题）。
const INVITE_THRESHOLD = 2;

// 会话级 frame 状态机（每通全新，与 ModeTracker 同生命周期）。可单测。
export class CoachTracker {
  private frame: Frame = 'friend';
  private inviteStreak = 0;
  private pendingInvite = false;

  // 每轮喂一个 coachCue，返回本轮应采用的 frame。
  next(cue: CoachCue): Frame {
    if (this.frame === 'coach') {
      // 教练态：对方说「做成了/解决了/放下了」→ 退回朋友，收口（别赖在教练里硬推）。
      if (cue.resolved) this.exitToFriend();
      return this.frame;
    }

    if (this.pendingInvite) {
      // 上一轮已温柔邀入，用户这一轮接话与否决定进不进。
      if (cue.explicit || cue.invite) {
        this.enterCoach();
      } else {
        this.pendingInvite = false; // 不接 / 换话题：回到陪伴，别再追问
        this.inviteStreak = 0;
      }
    } else if (cue.explicit) {
      this.enterCoach();
    } else if (cue.invite) {
      this.inviteStreak += 1;
      if (this.inviteStreak >= INVITE_THRESHOLD) this.pendingInvite = true;
    } else {
      this.inviteStreak = 0;
    }
    return this.frame;
  }

  private enterCoach() {
    this.frame = 'coach';
    this.inviteStreak = 0;
    this.pendingInvite = false;
  }

  private exitToFriend() {
    this.frame = 'friend';
    this.inviteStreak = 0;
    this.pendingInvite = false;
  }

  get current(): Frame {
    return this.frame;
  }

  // 本轮是否要注入温柔邀请（[INVITE] 块）。
  get shouldInvite(): boolean {
    return this.pendingInvite;
  }
}
