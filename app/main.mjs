// 桌面置顶卡片窗口：透明、不占任务栏、不抢焦点、卡片以外点击穿透。
// 只在创建窗口和手动「显示」时置顶，不做定时重新置顶：那样会打断全屏游戏和截图。
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeSessionVariables } from '../lib/env.mjs';
import { scanHistory, SESSION_ID_RE } from '../lib/history.mjs';
import { claudeDir, dataDir } from '../lib/paths.mjs';
import { placeBeside } from '../lib/placement.mjs';
import { startServer } from '../lib/server.mjs';
import { buildTrayImage } from './tray-icon.mjs';

removeSessionVariables();

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOW_FILE = join(dataDir(), 'window.json');
const WIDTH = 360;
const SIZES = { small: 0.85, standard: 1, large: 1.2 };
const MARGIN = 16;
const DEFAULT_OFFSET_Y = 80;
const TITLE_SCAN_BYTES = 4 * 1024 * 1024;
const POINTER_POLL_MS = 200;
const RECENT_DIRS_MAX = 8;
const REOPEN_COOLDOWN_MS = 30_000;
const ACTIVE_STATES = new Set(['thinking', 'working', 'waiting']);
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const AUTOSTART_NAME = 'claude-session-cards';
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
let contentHeight = 40;
let offeredDirs = new Set();
const recentlyOpened = new Map();
let editingReturnTo = null;
let pinned = true;
let appearance = { theme: 'system', opacity: 'standard', size: 'standard', usage: { today: true, week: true, fiveHour: true, sevenDay: true } };
let historyWin = null;

/** 主题交给 nativeTheme：所有窗口的 prefers-color-scheme 都跟着变。 */
function setAppearance({ theme, opacity, size, usage }) {
  if (Object.hasOwn(SIZES, size)) appearance.size = size;
  for (const key of Object.keys(appearance.usage)) {
    if (typeof usage?.[key] === 'boolean') appearance.usage[key] = usage[key];
  }
  if (THEMES.has(theme)) appearance.theme = theme;
  if (OPACITIES.has(opacity)) appearance.opacity = opacity;
  nativeTheme.themeSource = appearance.theme;
}

function loadPosition() {
  try {
    const { x, y, pinned: savedPinned, theme, opacity, size, usage } = JSON.parse(readFileSync(WINDOW_FILE, 'utf8'));
    if (typeof savedPinned === 'boolean') pinned = savedPinned;
    setAppearance({ theme, opacity, size, usage });
    if (Number.isInteger(x) && Number.isInteger(y)) {
      // 显示器可能已拔掉：位置不在任何屏幕内就回到默认
      const area = screen.getDisplayNearestPoint({ x, y }).workArea;
      if (x >= area.x - WIDTH / 2 && x < area.x + area.width - WIDTH / 2 && y >= area.y && y < area.y + area.height - 40) return { x, y };
    }
  } catch {}
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + MARGIN, y: area.y + DEFAULT_OFFSET_Y };
}

const scale = () => SIZES[appearance.size];
const scaledWidth = () => Math.round(WIDTH * scale());

/** 缩放整个页面。窗口大小要跟着变，高度按最后一次上报的内容高度换算。 */
function applySize() {
  win.webContents.setZoomFactor(scale());
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const wanted = Math.max(30, Math.ceil(contentHeight * scale()));
  win.setBounds({ x: b.x, y: b.y, width: scaledWidth(), height: Math.min(Math.max(60, area.y + area.height - MARGIN - b.y), wanted) });
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
    x, y, width: scaledWidth(), height: 40,
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
  win.webContents.on('did-finish-load', applySize);
  // 用 localhost：Chromium 的缩放按来源生效，这样不会连带放大 127.0.0.1 上的历史窗口
  win.loadURL(`http://localhost:${server.port}/`);
}

/** 从 transcript 末尾取会话的所有标题。改名后运行中的终端标签可能还是旧标题，所以都用来匹配。 */
function sessionTitles(path) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return [];
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TITLE_SCAN_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    const found = [];
    for (const key of ['customTitle', 'aiTitle']) {
      const matches = [...text.matchAll(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`, 'g'))];
      if (matches.length) found.push(JSON.parse(matches.at(-1)[1]));
    }
    return found;
  } catch {
    return []; // 读不到只影响能否选中标签页
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const hwndOf = (window) => {
  const handle = window.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
};

/** 运行切换脚本，返回切换前的前台窗口句柄。 */
function runFocusScript(env) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'focus-window.ps1')], { env: { ...process.env, CARDS_CHAIN: '', ...env }, timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(String(stdout).match(/previous=(\d+)/)?.[1] ?? null);
    });
  });
}

/** 改标题要键盘焦点。平时卡片窗口不抢焦点，所以临时打开，并记住原来的窗口。 */
async function beginEditing() {
  if (process.platform !== 'win32') {
    win.setFocusable(true);
    win.focus();
    return;
  }
  // 必须最先读：setFocusable 和 focus 都可能改变前台窗口，之后就读不到原来的窗口了
  const own = hwndOf(win);
  const previous = await runFocusScript({ CARDS_QUERY: '1' });
  editingReturnTo = previous && previous !== own ? previous : null;
  win.setFocusable(true);
  await runFocusScript({ CARDS_HWND: own });
}

/** 把焦点还给改标题之前的窗口；用户已经点到别的程序时不抢回来。 */
async function endEditing() {
  const returnTo = editingReturnTo;
  editingReturnTo = null;
  if (!returnTo) {
    win.blur();
    win.setFocusable(false);
    return;
  }
  // setFocusable(false) 会让系统把前台交给下一个窗口，所以要先判断、后恢复
  const stillOurs = (await runFocusScript({ CARDS_QUERY: '1' })) === hwndOf(win);
  win.setFocusable(false);
  if (stillOurs) await runFocusScript({ CARDS_HWND: returnTo });
}

/** 切到会话所在的窗口。返回 'focused' | 'refused' | 'running'（在运行但找不到窗口）| 'closed'。 */
function focusSession(id, titles) {
  const session = server.getSession(id);
  const env = {
    ...process.env,
    CARDS_CHAIN: (session?.chain ?? []).map((p) => `${p.pid}:${p.name}`).join(','),
    CARDS_TITLE: titles.join('\n'),
    CARDS_SESSION: SESSION_ID_RE.test(id) ? id : '',
  };
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'focus-window.ps1')], { env, timeout: 15_000, windowsHide: true }, (err) => {
      if (!err) resolve('focused');
      else if (err.code === 3) resolve('refused');
      else if (err.code === 4) resolve('running');
      else resolve('closed');
    });
  });
}

/** 在新的 Windows Terminal 标签页运行命令；没有 Windows Terminal 时开普通控制台。 */
function openTerminal(cwd, command) {
  const shell = ['powershell.exe', '-NoExit', '-Command', command];
  const wt = spawn('wt.exe', ['-w', '0', 'new-tab', '-d', cwd.replaceAll(';', '\\;'), ...shell], { detached: true, stdio: 'ignore', windowsHide: false });
  wt.on('error', () => {
    spawn('cmd.exe', ['/c', 'start', '""', '/D', cwd, ...shell], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
  wt.unref();
}

/** 最近用过的目录，最近的在前；已删除的不显示。只支持 Windows，其他平台返回 null。 */
async function recentDirs() {
  if (process.platform !== 'win32') return null;
  const dirs = [];
  const seen = new Set();
  for (const { cwd } of await scanHistory(claudeDir())) {
    const key = cwd?.toLowerCase();
    if (!cwd || seen.has(key)) continue;
    seen.add(key);
    if (existsSync(cwd)) dirs.push(cwd);
    if (dirs.length >= RECENT_DIRS_MAX) break;
  }
  offeredDirs = new Set(dirs);
  return dirs;
}

/** 只接受刚列给用户的目录，页面不能让主进程在任意路径启动程序。 */
function newSession(cwd) {
  if (process.platform === 'win32' && offeredDirs.has(cwd) && existsSync(cwd)) openTerminal(cwd, 'claude');
}

async function pickDirectoryAndOpen() {
  if (process.platform !== 'win32') return;
  const { canceled, filePaths } = await dialog.showOpenDialog({ title: '选择新会话的目录', properties: ['openDirectory'] });
  if (!canceled && filePaths[0]) openTerminal(filePaths[0], 'claude');
}

/**
 * 会话开着就切过去，确实关了才新开标签恢复：同一个会话开两个进程，记录会分叉。
 * 返回 'focused' | 'refused' | 'running' | 'opened' | 'no-dir' | 'not-found' | 'unsupported'。
 */
async function openSession(id) {
  if (process.platform !== 'win32') return 'unsupported';
  const session = server.getSession(id);
  const hadChain = Boolean(session?.chain?.length);
  const entry = SESSION_ID_RE.test(id) ? (await scanHistory(claudeDir())).find((s) => s.id === id) : undefined;
  const result = await focusSession(id, [...new Set([...sessionTitles(session?.transcript), entry?.title].filter(Boolean))]);
  if (result !== 'closed') return result;

  if (session) session.chain = null; // 记录已失效，让 hook 下次重新上报
  // 还没收到进程链又正在工作：可能只是上报慢了，宁可不开
  if (!hadChain && session && ACTIVE_STATES.has(session.state) && Date.now() - session.updatedAt < ACTIVE_WINDOW_MS) return 'running';
  if (!entry) return 'not-found';
  if (!entry.cwd || !existsSync(entry.cwd)) return 'no-dir';
  // 刚开的窗口要几秒才查得到，连点不能开出第二个
  if (Date.now() - (recentlyOpened.get(id) ?? 0) < REOPEN_COOLDOWN_MS) return 'opened';
  recentlyOpened.set(id, Date.now());
  openTerminal(entry.cwd, `claude --resume ${id}`); // id 已按 UUID 校验过
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

const loginOptions = () => ({ path: process.execPath, args: [app.getAppPath()], name: AUTOSTART_NAME });

/** 只支持 Windows；其他平台返回 null，不显示这个选项。 */
function isAutostartEnabled() {
  if (process.platform !== 'win32') return null;
  // openAtLogin 要启动命令完全一致才为 true，对不上引号和参数，所以按启动项名称判断
  return app.getLoginItemSettings(loginOptions()).launchItems.some((item) => item.name === AUTOSTART_NAME);
}

function setAutostart(on) {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ ...loginOptions(), openAtLogin: on });
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
  ipcMain.handle('resume-session', (e, id) => (fromHistory(e) ? openSession(String(id)) : 'not-found'));
  ipcMain.handle('set-editing', (e, on) => {
    if (fromOurWindow(e)) return on ? beginEditing() : endEditing();
  });
  ipcMain.handle('get-appearance', () => appearance);
  ipcMain.on('set-appearance', (e, value) => {
    if (!fromOurWindow(e)) return;
    setAppearance(value ?? {});
    applySize();
    savePosition();
  });
  ipcMain.handle('recent-dirs', (e) => (fromOurWindow(e) ? recentDirs() : null));
  ipcMain.on('new-session', (e, cwd) => {
    if (fromOurWindow(e)) newSession(String(cwd));
  });
  ipcMain.on('pick-directory', (e) => {
    if (fromOurWindow(e)) pickDirectoryAndOpen();
  });
  ipcMain.handle('get-autostart', () => isAutostartEnabled());
  ipcMain.on('set-autostart', (e, on) => {
    if (fromOurWindow(e)) setAutostart(on === true);
  });
  ipcMain.handle('get-pinned', () => pinned);
  ipcMain.on('set-pinned', (e, on) => {
    if (fromOurWindow(e)) setPinned(on === true);
  });
  ipcMain.handle('focus-session', (e, id) => (fromOurWindow(e) ? openSession(String(id)) : 'not-found'));
  ipcMain.on('interactive', (e, on) => {
    if (fromOurWindow(e)) setClickThrough(!on);
  });
  ipcMain.on('resize', (e, height, menuOpen) => {
    if (!fromOurWindow(e) || !Number.isFinite(height)) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    contentHeight = height;
    const wanted = Math.max(30, Math.ceil(height * scale()));
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
    win.setBounds({ x: b.x, y, width: scaledWidth(), height: Math.min(Math.max(60, bottom - y), wanted) });
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
    server = startServer({ onShutdown: () => app.quit() });
    await server.ready;
    setupIpc();
    createWindow();
    watchPointer();
    tray = new Tray(buildTrayImage(nativeImage));
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
