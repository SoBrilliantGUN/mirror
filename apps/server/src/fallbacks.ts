import type {
  AcousticFeatures,
  DependenceSignals,
  SafetyCheck,
  SafetyGuard,
} from '@mirror/contracts';

// 兜底实现（非「未完成的占位」）：生产/评测共用。
// - NoopSafetyGuard：安全红线 L4 的 no-op 实现，eval / demo 无安全检测时用。
// - neutralAcoustic：副语言 z-score 兜底——L0 未接时给 0（正常）。真正的 z-score 由 L0 AcousticFeatureExtractor 产出。
export class NoopSafetyGuard implements SafetyGuard {
  async check(_text: string, _signals?: DependenceSignals): Promise<SafetyCheck> {
    return {
      crisis: { level: 0, action: 'none' },
      dependence: { level: 0, action: 'none' },
    };
  }
}

export function neutralAcoustic(): AcousticFeatures {
  return { rateZ: 0, pitchZ: 0, loudnessZ: 0, pauseZ: 0 };
}
