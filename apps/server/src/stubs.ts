import type {
  AcousticFeatures,
  DependenceSignals,
  SafetyCheck,
  SafetyGuard,
} from '@mirror/contracts';

// 安全红线 L4 未实现时返回 none（eval / demo 无安全检测时用）。
export class NoopSafetyGuard implements SafetyGuard {
  async check(_text: string, _signals?: DependenceSignals): Promise<SafetyCheck> {
    return {
      crisis: { level: 0, action: 'none' },
      dependence: { level: 0, action: 'none' },
    };
  }
}

// 副语言 z-score：L0 未接时给 0（正常）。真正的 z-score 由 L0 AcousticFeatureExtractor 产出。
export function neutralAcoustic(): AcousticFeatures {
  return { rateZ: 0, pitchZ: 0, loudnessZ: 0, pauseZ: 0 };
}
