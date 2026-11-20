// 构建脚本：用 esbuild 把 server 源码、main、preload 分别打包。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const dist = join(__dirname, 'dist');
mkdirSync(dist, { recursive: true });

// 应用图标拷到 dist/，供 BrowserWindow 的窗口/任务栏图标用（dev 与打包后都从 dist/ 取）。
copyFileSync(join(__dirname, 'build', 'icon.png'), join(dist, 'icon.png'));

// 1) server 子进程入口（bundles server 源码；node_modules 全外部化，运行时从 node_modules 解析）。
await build({
  entryPoints: [join(root, 'apps', 'server', 'src', 'run.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  outfile: join(dist, 'server.mjs'),
});

// 2) Electron 主进程（electron / embedded-postgres 外部化）。
await build({
  entryPoints: [join(__dirname, 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  outfile: join(dist, 'main.mjs'),
});

// 3) preload（CJS，contextBridge 最稳）。
await build({
  entryPoints: [join(__dirname, 'src', 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  packages: 'external',
  outfile: join(dist, 'preload.cjs'),
});

console.log('[build] desktop 构建完成 → apps/desktop/dist/');
