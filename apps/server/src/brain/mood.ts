import type { Affect, MoodState } from '@mirror/contracts';

// mood = affect 的多轮 EMA：mood_t = α·affect_t + (1-α)·mood_{t-1}，α≈0.6。
const ALPHA = 0.6;

export function updateMood(prev: MoodState | null, affect: Affect): MoodState {
  const v = prev ?? { valence: 0, arousal: 0, dominance: 0 };
  return {
    valence: round2(ALPHA * affect.valence + (1 - ALPHA) * v.valence),
    arousal: round2(ALPHA * affect.arousal + (1 - ALPHA) * v.arousal),
    dominance: round2(ALPHA * affect.dominance + (1 - ALPHA) * v.dominance),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
