import type {
  AcousticFeatures,
  Context,
  ContextProvider,
  DependenceSignals,
  SafetyCheck,
  SafetyGuard,
} from '@mirror/contracts';

// 第一片 stub：安全红线 L4 未实现，先返回 none（eval / demo 无安全检测时用）。
export class NoopSafetyGuard implements SafetyGuard {
  async check(_text: string, _signals?: DependenceSignals): Promise<SafetyCheck> {
    return {
      crisis: { level: 0, action: 'none' },
      dependence: { level: 0, action: 'none' },
    };
  }
}

// 第一片 stub：上下文（记忆 / MBTI / 时间）都空。
export class EmptyContextProvider implements ContextProvider {
  async get(_userId: string): Promise<Context> {
    return { history: [], mood: null };
  }
}

// 副语言 z-score：第一片 L0 未接，先给 0（正常）。
// 真正的 z-score 由 L0 AcousticFeatureExtractor 产出，随音频一起上行。
export function neutralAcoustic(): AcousticFeatures {
  return { rateZ: 0, pitchZ: 0, loudnessZ: 0, pauseZ: 0 };
}
