#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeSessionVariables } from '../lib/env.mjs';
import { APP_ID, claudeDir, dataDir, port } from '../lib/paths.mjs';
import { install, isInstalled, uninstall } from '../lib/settings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://127.0.0.1:${port()}`;
const START_TIMEOUT_MS = 20_000;

const USAGE = `用法: ${APP_ID} <命令>

  install [--dsh-pet]     把 hook 写入 Claude Code 配置（--dsh-pet 同时联动 DSH 桌宠）
  uninstall [--purge]     移除 hook（--purge 同时删除本地状态数据）
  start [--web]           启动置顶卡片窗口
                            --web        不开窗口，只提供网页 ${BASE}/
  stop                    退出
  status                  查看运行状态和当前会话
`;

async function health() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return { foreign: true };
    const body = await res.json();
    return body.app === APP_ID ? body : { foreign: true };
  } catch (err) {
    return err?.cause?.code === 'ECONNREFUSED' || err?.name === 'TimeoutError' ? null : { foreign: true };
  }
}

/** 返回 Electron 可执行文件路径；require('electron') 在本体缺失时会自行下载。不可用时返回 null。 */
function electronBinary() {
  const require = createRequire(join(ROOT, 'package.json'));
  try {
    const dir = dirname(require.resolve('electron/package.json'));
    if (!existsSync(join(dir, 'path.txt'))) {
      console.log('首次启动，正在下载 Electron…');
      downloadElectron(dir);
    }
    const binary = require('electron');
    return typeof binary === 'string' ? binary : null;
  } catch {
    return null;
  }
}

/** Electron 的下载器默认不走系统代理：先按环境变量走代理，失败再试国内镜像（文件都按包内 checksums.json 校验）。 */
function downloadElectron(dir) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const base = proxy ? { ELECTRON_GET_USE_PROXY: '1', GLOBAL_AGENT_HTTPS_PROXY: proxy, GLOBAL_AGENT_HTTP_PROXY: proxy } : {};
  const attempts = process.env.ELECTRON_MIRROR ? [base] : [base, { ...base, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' }];
  for (const extra of attempts) {
    const res = spawnSync(process.execPath, [join(dir, 'install.js')], { stdio: 'ignore', env: { ...process.env, ...extra } });
    if (res.status === 0 && existsSync(join(dir, 'path.txt'))) return;
    if (extra.ELECTRON_MIRROR === undefined && attempts.length > 1) console.log('下载失败，改用 npmmirror 镜像重试…');
  }
}

function launch(command, args, env) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, 'app.log'), 'a');
  spawn(command, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true, env }).unref();
}

/** 卸载时清掉开机启动项。指定了数据目录说明是隔离运行（如测试），不碰真实的启动项。 */
function removeAutostart() {
  if (process.platform !== 'win32' || process.env.CLAUDE_SESSION_CARDS_HOME) return;
  spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', APP_ID, '/f'], { stdio: 'ignore', windowsHide: true });
}

async function start(flags) {
  const running = await health();
  if (running?.foreign) throw new Error(`端口 ${port()} 被其他程序占用。可设置 CLAUDE_SESSION_CARDS_PORT 换一个端口（Claude Code 也要设置同样的环境变量）`);
  if (running) {
    console.log(`已在运行: ${BASE}/`);
    return;
  }
  const env = removeSessionVariables({ ...process.env });
  delete env.ELECTRON_RUN_AS_NODE;

  const binary = flags.has('--web') ? null : electronBinary();
  if (binary) launch(binary, [ROOT], env);
  else {
    if (!flags.has('--web')) console.log('Electron 不可用，改用网页模式。');
    launch(process.execPath, [join(ROOT, 'lib', 'server.mjs')], env);
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  let up = null;
  while (Date.now() < deadline && !(up = await health())) await new Promise((r) => setTimeout(r, 200));
  if (!up || up.foreign) throw new Error(`启动失败，日志见 ${join(dataDir(), 'app.log')}`);
  console.log(binary ? `已启动置顶卡片，网页: ${BASE}/` : `已启动网页模式: ${BASE}/`);
  if (!isInstalled(claudeDir())) console.log(`提示: 还没安装 hook，请运行 ${APP_ID} install`);
}

async function stop() {
  const running = await health();
  if (!running) return console.log('没有在运行。');
  if (running.foreign) throw new Error(`端口 ${port()} 上不是 ${APP_ID}，未做任何操作`);
  await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log('已退出。');
}

async function status() {
  const running = await health();
  console.log(`hook: ${isInstalled(claudeDir()) ? '已安装' : '未安装'}`);
  if (!running) return console.log('服务: 未运行');
  if (running.foreign) return console.log(`服务: 端口 ${port()} 被其他程序占用`);
  console.log(`服务: 运行中 ${BASE}/`);
  const { sessions } = await (await fetch(`${BASE}/api/sessions`)).json();
  for (const s of sessions) console.log(`  ${s.id.slice(0, 8)}  ${s.state.padEnd(8)}  ${s.project}`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest);

try {
  switch (command) {
    case 'install': {
      const { file, statusLine } = install(claudeDir(), { dshPet: flags.has('--dsh-pet') });
      console.log(`已写入 ${file}（原文件备份为 settings.json.bak-claude-session-cards）`);
      console.log(statusLine ? '已配置状态栏，用于读取套餐限额。' : '你已经配置了别的状态栏，没有覆盖；Token 用量正常显示，但读不到套餐限额。');
      console.log('已打开的 Claude Code 会话需要重启，或打开一次 /hooks 才会加载。');
      break;
    }
    case 'uninstall': {
      const file = uninstall(claudeDir());
      console.log(`已从 ${file} 移除 hook。`);
      removeAutostart();
      if (flags.has('--purge')) {
        await stop();
        rmSync(dataDir(), { recursive: true, force: true });
        console.log('已删除本地状态数据。');
      }
      break;
    }
    case 'start':
      await start(flags);
      break;
    case 'stop':
      await stop();
      break;
    case 'status':
      await status();
      break;
    default:
      console.log(USAGE);
      process.exitCode = command && command !== 'help' && command !== '--help' ? 1 : 0;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
