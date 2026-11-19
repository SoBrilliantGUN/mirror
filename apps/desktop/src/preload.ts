// preload：经 contextBridge 暴露给前端一个安全的最小设置桥。CJS 打包。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mirrorSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (s: unknown) => ipcRenderer.invoke('settings:set', s),
  restart: () => ipcRenderer.invoke('app:restart'),
});
