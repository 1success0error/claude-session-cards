// 桌面置顶卡片窗口：透明、不占任务栏、不抢焦点、卡片以外点击穿透。
// 只在创建窗口和手动「显示」时置顶，不做定时重新置顶：那样会打断全屏游戏和截图。
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHistory, SESSION_ID_RE } from '../lib/history.mjs';
import { claudeDir, dataDir } from '../lib/paths.mjs';
import { placeBeside } from '../lib/placement.mjs';
import { startServer } from '../lib/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOW_FILE = join(dataDir(), 'window.json');
const WIDTH = 320;
const MARGIN = 16;
const DEFAULT_OFFSET_Y = 80;
const TITLE_SCAN_BYTES = 4 * 1024 * 1024;
const POINTER_POLL_MS = 200;
const AUTOSTART_NAME = 'claude-session-cards';
const TAILSCALE = process.env.CLAUDE_SESSION_CARDS_TAILSCALE === '1' || process.argv.includes('--tailscale');
const HISTORY_SIZE = { width: 760, height: 680 };
const THEMES = new Set(['system', 'dark', 'light']);
const OPACITIES = new Set(['opaque', 'standard', 'translucent']);
// Electron 的 forward 选项只支持 Windows 和 macOS：Linux 上穿透后就再也收不到鼠标，所以不穿透
const CLICK_THROUGH = process.platform !== 'linux';

let win = null;
let tray = null;
let server = null;
let dragOrigin = null;
let menuShift = null;
let pinned = true;
let appearance = { theme: 'system', opacity: 'standard' };
let historyWin = null;

/** 主题交给 nativeTheme：所有窗口的 prefers-color-scheme 都跟着变，手机网页不受影响。 */
function setAppearance({ theme, opacity }) {
  if (THEMES.has(theme)) appearance.theme = theme;
  if (OPACITIES.has(opacity)) appearance.opacity = opacity;
  nativeTheme.themeSource = appearance.theme;
}

function loadPosition() {
  try {
    const { x, y, pinned: savedPinned, theme, opacity } = JSON.parse(readFileSync(WINDOW_FILE, 'utf8'));
    if (typeof savedPinned === 'boolean') pinned = savedPinned;
    setAppearance({ theme, opacity });
    if (Number.isInteger(x) && Number.isInteger(y)) {
      // 显示器可能已拔掉：位置不在任何屏幕内就回到默认
      const area = screen.getDisplayNearestPoint({ x, y }).workArea;
      if (x >= area.x - WIDTH / 2 && x < area.x + area.width - WIDTH / 2 && y >= area.y && y < area.y + area.height - 40) return { x, y };
    }
  } catch {}
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + MARGIN, y: area.y + DEFAULT_OFFSET_Y };
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const { x, y: currentY } = win.getBounds();
  const y = menuShift ?? currentY; // 菜单造成的临时上移不算用户摆放的位置
  try {
    mkdirSync(dirname(WINDOW_FILE), { recursive: true });
    writeFileSync(WINDOW_FILE, JSON.stringify({ x, y, pinned, ...appearance }));
  } catch {}
}

function setClickThrough(on) {
  if (CLICK_THROUGH) win.setIgnoreMouseEvents(on, { forward: true });
}

function pinOnTop() {
  win.setAlwaysOnTop(pinned, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(pinned, { visibleOnFullScreen: pinned });
}

function createWindow() {
  const { x, y } = loadPosition();
  win = new BrowserWindow({
    x, y, width: WIDTH, height: 40,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: pinned,
    focusable: false,
    show: false,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  pinOnTop();
  setClickThrough(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });
  win.loadURL(`http://127.0.0.1:${server.port}/`);
}

/** 从 transcript 末尾取会话标题（手动命名优先），用来匹配 Windows Terminal 的标签。 */
function sessionTitle(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TITLE_SCAN_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    for (const key of ['customTitle', 'aiTitle']) {
      const matches = [...text.matchAll(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`, 'g'))];
      if (matches.length) return JSON.parse(matches.at(-1)[1]);
    }
  } catch {
    // 标题只影响能否选中标签页，读不到就只切窗口
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

/** Windows 的前台锁可能让 win.focus() 无效，所以用和跳转窗口相同的办法切到前台。 */
function forceForeground() {
  if (process.platform !== 'win32') return Promise.resolve();
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'focus-window.ps1')], { env: { ...process.env, CARDS_HWND: hwnd.toString(), CARDS_CHAIN: '' }, timeout: 5000, windowsHide: true }, () => resolve());
  });
}

/** 返回 'focused' | 'no-window' | 'refused' | 'unsupported'。 */
function focusSession(id) {
  const session = server.getSession(id);
  if (process.platform !== 'win32') return Promise.resolve('unsupported');
  if (!session?.chain?.length) return Promise.resolve('no-window');
  const env = {
    ...process.env,
    CARDS_CHAIN: session.chain.map((p) => `${p.pid}:${p.name}`).join(','),
    CARDS_TITLE: sessionTitle(session.transcript) ?? '',
  };
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'focus-window.ps1')], { env, timeout: 10_000, windowsHide: true }, (err) => {
      if (!err) resolve('focused');
      else resolve(err.code === 3 ? 'refused' : 'no-window');
    });
  });
}

/** 在新的 Windows Terminal 标签页恢复；没有 Windows Terminal 时开普通控制台。 */
function openResumeTerminal(id, cwd) {
  // id 已按 UUID 校验过，可以放进命令行
  const shell = ['powershell.exe', '-NoExit', '-Command', `claude --resume ${id}`];
  const wt = spawn('wt.exe', ['-w', '0', 'new-tab', '-d', cwd.replaceAll(';', '\\;'), ...shell], { detached: true, stdio: 'ignore', windowsHide: false });
  wt.on('error', () => {
    spawn('cmd.exe', ['/c', 'start', '""', '/D', cwd, ...shell], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
  wt.unref();
}

/** 返回 'opened' | 'focused' | 'no-dir' | 'not-found' | 'unsupported'。 */
async function resumeSession(id) {
  if (!SESSION_ID_RE.test(id)) return 'not-found';
  // 会话还开着就切过去：同一个会话开两个进程，记录会分叉
  if (server.getSession(id)?.chain?.length) {
    const result = await focusSession(id);
    if (result === 'focused' || result === 'refused') return 'focused';
  }
  if (process.platform !== 'win32') return 'unsupported';
  const entry = (await scanHistory(claudeDir())).find((s) => s.id === id);
  if (!entry) return 'not-found';
  if (!entry.cwd || !existsSync(entry.cwd)) return 'no-dir';
  openResumeTerminal(id, entry.cwd);
  return 'opened';
}

function openHistoryWindow() {
  if (historyWin) {
    if (historyWin.isMinimized()) historyWin.restore();
    historyWin.show();
    historyWin.focus();
    return;
  }
  // 打开时跟随卡片当前所在的位置和显示器；已打开的窗口保留用户摆放的位置
  const anchor = win.getBounds();
  historyWin = new BrowserWindow({
    ...placeBeside(anchor, HISTORY_SIZE, screen.getDisplayMatching(anchor).workArea),
    minWidth: 420,
    minHeight: 360,
    title: 'Claude 历史会话',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181c' : '#f3f4f6',
    autoHideMenuBar: true,
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  historyWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  historyWin.webContents.on('will-navigate', (e) => e.preventDefault());
  historyWin.on('closed', () => { historyWin = null; });
  historyWin.loadURL(`http://127.0.0.1:${server.port}/history.html`);
}

// 开机启动时没有命令行环境，所以把应用目录和 Tailscale 设置都写进启动命令
const autostartArgs = (tailscale) => [app.getAppPath(), ...(tailscale ? ['--tailscale'] : [])];
const loginOptions = (tailscale) => ({ path: process.execPath, args: autostartArgs(tailscale), name: AUTOSTART_NAME });

/** 只支持 Windows；其他平台返回 null，不显示这个选项。 */
function isAutostartEnabled() {
  if (process.platform !== 'win32') return null;
  // openAtLogin 要启动命令完全一致才为 true，对不上引号和参数，所以按启动项名称判断
  return app.getLoginItemSettings(loginOptions(TAILSCALE)).launchItems.some((item) => item.name === AUTOSTART_NAME);
}

function setAutostart(on) {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ ...loginOptions(TAILSCALE), openAtLogin: on });
  updateTray();
}

function setPinned(on) {
  pinned = on;
  pinOnTop();
  if (on) win.moveTop();
  savePosition();
  updateTray();
}

function pinnedMenuItem() {
  return { label: '窗口置顶', type: 'checkbox', checked: pinned, click: (item) => setPinned(item.checked) };
}

/** 窗口穿透时收不到鼠标事件，只能按光标位置判断鼠标是否离开了窗口。 */
function watchPointer() {
  let inside = false;
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || dragOrigin) return;
    const { x, y } = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const now = x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
    if (inside && !now) win.webContents.send('pointer-left');
    inside = now;
  }, POINTER_POLL_MS);
}

function setupIpc() {
  const fromOurWindow = (e) => win && e.sender === win.webContents;
  const fromHistory = (e) => historyWin && e.sender === historyWin.webContents;
  ipcMain.on('open-history', (e) => {
    if (fromOurWindow(e)) openHistoryWindow();
  });
  ipcMain.handle('resume-session', (e, id) => (fromHistory(e) ? resumeSession(String(id)) : 'not-found'));
  // 平时不抢焦点；只有改标题时才需要键盘输入
  ipcMain.handle('set-editing', async (e, on) => {
    if (!fromOurWindow(e)) return;
    win.setFocusable(on);
    if (!on) {
      win.blur();
      return;
    }
    win.focus();
    await forceForeground(); // isFocused() 在前台锁下仍可能返回 true，不能用来判断
  });
  ipcMain.handle('get-appearance', () => appearance);
  ipcMain.on('set-appearance', (e, value) => {
    if (!fromOurWindow(e)) return;
    setAppearance(value ?? {});
    savePosition();
  });
  ipcMain.handle('get-autostart', () => isAutostartEnabled());
  ipcMain.on('set-autostart', (e, on) => {
    if (fromOurWindow(e)) setAutostart(on === true);
  });
  ipcMain.handle('get-pinned', () => pinned);
  ipcMain.on('set-pinned', (e, on) => {
    if (fromOurWindow(e)) setPinned(on === true);
  });
  ipcMain.handle('focus-session', (e, id) => (fromOurWindow(e) ? focusSession(String(id)) : 'no-window'));
  ipcMain.on('interactive', (e, on) => {
    if (fromOurWindow(e)) setClickThrough(!on);
  });
  ipcMain.on('resize', (e, height, menuOpen) => {
    if (!fromOurWindow(e) || !Number.isFinite(height)) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const wanted = Math.max(30, Math.ceil(height));
    const bottom = area.y + area.height - MARGIN;
    let y = b.y;
    if (menuOpen && y + wanted > bottom) {
      // 菜单放不下时窗口临时上移，关闭后回到原位；卡片内容本身仍然只在窗口内滚动
      menuShift ??= y;
      y = Math.max(area.y + MARGIN, bottom - wanted);
    } else if (!menuOpen && menuShift !== null) {
      y = menuShift;
      menuShift = null;
    }
    win.setBounds({ x: b.x, y, width: WIDTH, height: Math.min(Math.max(60, bottom - y), wanted) });
  });
  ipcMain.on('drag-start', (e) => {
    if (fromOurWindow(e)) dragOrigin = win.getBounds();
  });
  ipcMain.on('drag-move', (e, dx, dy) => {
    if (!fromOurWindow(e) || !dragOrigin || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    win.setBounds({ ...dragOrigin, x: Math.round(dragOrigin.x + dx), y: Math.round(dragOrigin.y + dy) });
  });
  ipcMain.on('drag-end', (e) => {
    if (!fromOurWindow(e)) return;
    dragOrigin = null;
    savePosition();
  });
  ipcMain.handle('copy', (e, text) => {
    if (fromOurWindow(e) || fromHistory(e)) clipboard.writeText(text);
  });
}

function trayIcon(color) {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      if (Math.hypot(px - c, py - c) > 6.5) continue;
      const i = (py * size + px) * 4;
      buf[i] = color[2]; buf[i + 1] = color[1]; buf[i + 2] = color[0]; buf[i + 3] = 255; // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  const showing = Boolean(win?.isVisible());
  const items = [
    {
      label: showing ? '隐藏卡片' : '显示卡片',
      click: () => {
        if (win?.isVisible()) win.hide();
        else if (win) {
          win.showInactive();
          pinOnTop();
          win.moveTop();
        }
        updateTray();
      },
    },
    pinnedMenuItem(),
    { label: '历史会话…', click: () => openHistoryWindow() },
  ];
  const autostart = isAutostartEnabled();
  if (autostart !== null) items.push({ label: '开机自启', type: 'checkbox', checked: autostart, click: (item) => setAutostart(item.checked) });
  items.push({ type: 'separator' }, { label: '退出', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.dock?.hide();
  app.whenReady().then(async () => {
    server = startServer({ tailscale: TAILSCALE, onShutdown: () => app.quit() });
    server.onChange(updateTray);
    await server.ready;
    setupIpc();
    createWindow();
    watchPointer();
    tray = new Tray(trayIcon([76, 195, 138]));
    tray.setToolTip('Claude 会话卡片');
    updateTray();
  }).catch((err) => {
    console.error('[claude-session-cards] start failed', err);
    app.exit(1);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('before-quit', () => {
    savePosition();
    server?.close();
  });
}
