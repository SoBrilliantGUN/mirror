// NLS 声音事件检测连通性测试：用 .env 里的 NLS_APPKEY + NLS_TOKEN 连一次，验证凭证 + 命令名。
// 运行：npm run test-nls（或 tsx apps/server/src/scripts/test-nls.ts）
import { loadConfig, loadDotEnv } from '../config';
import { NlsSoundEventDetector } from '../speech/nlsSoundEvent';

async function main() {
  loadDotEnv();
  const cfg = loadConfig();

  if (!cfg.nls.appKey) {
    console.error('未配 NLS_APPKEY');
    process.exit(1);
  }
  if (!cfg.nls.token && !(cfg.nls.akId && cfg.nls.akSecret)) {
    console.error('未配 NLS_TOKEN（或 NLS_ACCESS_KEY_ID/SECRET）');
    process.exit(1);
  }

  console.log('[test] 正在连接 NLS 声音事件检测...');
  const det = new NlsSoundEventDetector(
    { appKey: cfg.nls.appKey, token: cfg.nls.token || undefined, akId: cfg.nls.akId || undefined, akSecret: cfg.nls.akSecret || undefined },
    (ev) => console.log('[event] 检测到：', JSON.stringify(ev)),
  );
  await det.start();

  // 发 2s 静音 + 1s 440Hz 正弦——不该触发哭/笑，但会走完整上行流水线。
  const sr = 16000;
  const silent = Buffer.alloc(sr * 2 * 2);
  const sine = Buffer.alloc(sr * 2);
  for (let i = 0; i < sr; i++) {
    sine.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3 * 32767), i * 2);
  }
  det.sendPcm(silent);
  det.sendPcm(sine);

  await new Promise((r) => setTimeout(r, 3000));
  det.close();
  console.log('[test] 结束。看上面有没有「检测已开始」：有 = 凭证+命令名都对；TaskFailed/连接失败 = 需要修。');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
