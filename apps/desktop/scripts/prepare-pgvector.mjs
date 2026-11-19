// 把 vendor 里的 pgvector 文件塞进 embedded-postgres 的 Windows 原生目录（lib/ + share/extension/）。
// embedded-postgres 官方二进制不带 pgvector，这一步在 install/build 前执行，保证 CREATE EXTENSION vector 可用。
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..'); // 仓库根
const vendor = join(__dirname, '..', 'vendor', 'pgvector');
const target = join(root, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');

if (!existsSync(join(vendor, 'lib', 'vector.dll'))) {
  console.error('[prepare-pgvector] 缺少 vendor/pgvector/lib/vector.dll，请先放置 pgvector 二进制');
  process.exit(1);
}
if (!existsSync(target)) {
  console.error('[prepare-pgvector] 未找到 @embedded-postgres/windows-x64，请先 npm install');
  process.exit(1);
}

mkdirSync(join(target, 'lib'), { recursive: true });
mkdirSync(join(target, 'share', 'extension'), { recursive: true });
cpSync(join(vendor, 'lib'), join(target, 'lib'), { recursive: true });
cpSync(join(vendor, 'share', 'extension'), join(target, 'share', 'extension'), { recursive: true });

console.log('[prepare-pgvector] 已把 pgvector 复制进 embedded-postgres native 目录');
