/** @type {import('next').NextConfig} */
const nextConfig = {
  // 桌面版：纯客户端 SPA，静态导出后由 Electron 本地静态服务喂给窗口。
  output: 'export',
};

export default nextConfig;
