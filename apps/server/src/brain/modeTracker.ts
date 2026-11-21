import type { Affect, Mode, SafetyAction } from '@mirror/contracts';
import { decideMode } from './emotion';

// 防抖：退出 careful 需连续 2 轮平稳（放 L5 状态机，这里给一个有状态的 tracker）。
export class ModeTracker {
  private current: Mode = 'casual';
  private calmStreak = 0;

  next(affect: Affect, safety: SafetyAction): Mode {
    const raw = decideMode(affect, safety);
    if (raw === 'careful') {
      this.current = 'careful';
      this.calmStreak = 0;
    } else {
      this.calmStreak += 1;
      if (this.current === 'careful' && this.calmStreak >= 2) {
        this.current = 'casual';
      }
    }
    return this.current;
  }
}
