'use client';

import { useEffect, useState } from 'react';

// 顶部 iOS 式状态栏：左边时间、中间灵动岛、右边信号/无线/电量
export default function StatusBar() {
  const [time, setTime] = useState('9:41');

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setTime(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 20000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="statusbar">
      <span className="status-time">{time}</span>
      <span className="island" aria-hidden />
      <span className="status-icons">
        <span className="signal" aria-hidden>
          <i /><i /><i /><i />
        </span>
        <svg className="wifi" width="15" height="11" viewBox="0 0 15 11" fill="none" aria-hidden>
          <path d="M7.5 10a1 1 0 010-2 1 1 0 010 2z" fill="currentColor" />
          <path d="M4.2 7.2a4.7 4.7 0 016.6 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M1.8 4.8a8.1 8.1 0 0111.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span className="batt" aria-hidden><i /></span>
      </span>
    </div>
  );
}
