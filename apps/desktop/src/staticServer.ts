// 极简静态文件服务：喂给 Electron 窗口的 Next 静态导出产物（renderer/）。
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function startStaticServer(root: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // 每个请求独立兜底，任何单请求异常都不允许拖垮主进程。
      try {
        let urlPath: string;
        try {
          urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
        } catch {
          res.writeHead(400);
          res.end('bad request');
          return;
        }
        let filePath = join(root, urlPath === '/' ? 'index.html' : urlPath);
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          filePath = join(root, 'index.html'); // SPA 回退
        }
        const ext = extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');

        let body: Buffer;
        try {
          body = readFileSync(filePath); // 先读，成功再写 200；失败走 404（避免 headers 已发后再 writeHead）
        } catch {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200);
        res.end(body);
      } catch (e) {
        try {
          res.writeHead(500);
        } catch {
          /* ignore */
        }
        try {
          res.end('internal error');
        } catch {
          /* ignore */
        }
        console.error('[static] 请求处理异常', e);
      }
    });
    server.once('error', reject); // 端口被占等：直接 reject，别静默挂起
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
