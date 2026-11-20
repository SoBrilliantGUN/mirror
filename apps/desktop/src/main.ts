// Electron 主进程：起内嵌 PG → 起 server 子进程 → 静态服务喂前端 → 开窗口 + 设置 IPC。
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, settingsToEnv, type Settings } from './settings.js';
import { startPostgres, stopPostgres } from './pg.js';
import { startStaticServer } from './staticServer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SERVER_PORT = 3001;
const CLIENT_PORT = 3000;

let serverProc: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

// 主进程崩溃兜底：落日志 + 弹窗，然后退出（崩溃后状态不可靠，别带病运行）。孤儿 PG 下次启动会自动复用。
process.on('uncaughtException', (e) => {
  console.error('[main] uncaughtException：', e);
  dialog.showErrorBox('mirror 出错', String(e?.stack ?? e));
  app.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[main] unhandledRejection：', e);
});

function startServerChild(env: Record<string, string>): void {
  stopServerChild();
  const serverEntry = join(__dirname, 'server.mjs');
  // ELECTRON_RUN_AS_NODE=1：让 electron.exe 当纯 Node 用，跑 ESM 的 server.mjs（dev/打包行为一致）。
  serverProc = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on('exit', (code) => console.log('[server] 子进程退出，code=', code));
}

function stopServerChild(): void {
  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* 忽略 */
    }
    serverProc = null;
  }
}

async function boot(): Promise<void> {
  console.log('boot 开始');
  // 先亮窗口：静态服务 + 窗口秒开。内嵌 PG + server 冷启动（initdb/建表/播种）放到后台，
  // 别让首屏被 PG 初始化卡住——前端对 /contacts 已有退避重试，等 server 就绪后自然补上。
  // renderer 在 apps/desktop/renderer（dist/ 的上一级），与 dist/ 平级。
  await startStaticServer(join(__dirname, '..', 'renderer'), CLIENT_PORT);
  console.log('静态服务已起');
  await createWindow();
  console.log('窗口已创建');

  void bootBackend();
}

async function bootBackend(): Promise<void> {
  let databaseUrl = '';
  try {
    databaseUrl = await startPostgres();
    console.log('PG 启动成功：' + databaseUrl);
  } catch (e) {
    console.log('PG 启动失败：' + String(e));
    console.error('[pg] 内嵌 Postgres 启动失败：', e);
  }

  const settings = loadSettings();
  const env = settingsToEnv(settings);
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  env.GREETING_CACHE_DIR = join(app.getPath('userData'), 'greetings-cache');
  env.PORT = String(SERVER_PORT);
  env.ICE_HOST_ADDRESS = '127.0.0.1';
  env.MIRROR_SKIP_DOTENV = '1'; // 桌面版只用注入的 key，不读仓库 .env

  console.log('server 子进程启动中（execPath=' + process.execPath + '）');
  startServerChild(env);
}

function createWindow(): Promise<void> {
  return new Promise((resolve) => {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 900,
      minHeight: 620,
      title: 'mirror · 生活教练陪伴',
      backgroundColor: '#0f1020',
      icon: join(__dirname, 'icon.png'), // 任务栏/窗口图标（build.mjs 已拷到 dist/）
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http')) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[main] 窗口加载失败', code, desc, url);
    });
    mainWindow.once('ready-to-show', () => resolve());
    mainWindow.loadURL(`http://localhost:${CLIENT_PORT}`);
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // 去掉 File/Edit/View/Window 默认菜单

  // 语音通话要麦克风：放开 media 权限。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, s: Settings) => {
    saveSettings(s);
    return true;
  });
  ipcMain.handle('app:restart', async () => {
    // 先优雅停掉 server 子进程和 PG，再重启，避免残留进程撞端口。
    stopServerChild();
    await stopPostgres();
    app.relaunch();
    app.exit(0);
  });

  await boot();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 优雅关停：先停 server 子进程 + 内嵌 PG（pg_ctl stop），避免残留 postgres 进程占着 5432。
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  (async () => {
    stopServerChild();
    await stopPostgres();
    app.exit(0);
  })();
});
