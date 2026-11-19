// Electron preload 暴露的桥（contextBridge）。浏览器里跑（npm run dev）时不存在，设置入口自动隐藏。
import type { Settings } from './settings/types';

declare global {
  interface Window {
    mirrorSettings?: {
      get: () => Promise<Settings>;
      set: (s: Settings) => Promise<boolean>;
      restart: () => Promise<void>;
    };
  }
}

export {};
