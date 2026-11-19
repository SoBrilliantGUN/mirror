// CLI 入口：`npm start` 用。Electron 桌面版不走这里，而是 import { main } 后自行注入配置再调用。
import { main } from './server.js';

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
