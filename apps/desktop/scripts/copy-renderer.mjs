// 把客户端静态导出产物（apps/client/out）复制到桌面版的 renderer/。
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');
const src = join(root, 'apps', 'client', 'out');
const dst = join(__dirname, '..', 'renderer');

if (!existsSync(join(src, 'index.html'))) {
  console.error('[copy-renderer] 缺少 apps/client/out，请先 npm run build -w @mirror/client');
  process.exit(1);
}

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('[copy-renderer] 已复制客户端静态产物 → apps/desktop/renderer/');
