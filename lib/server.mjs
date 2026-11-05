// 会话状态服务：接收 hook 事件，按 session_id 维护状态，提供网页与 SSE。
// 默认只监听 127.0.0.1；--tailscale 时再监听 Tailscale 地址（只读）。写操作只接受本机请求。
import { execFile } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTitle, scanHistory } from './history.mjs';
import { APP_ID, claudeDir, dataDir, port as configuredPort } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'app', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC = new Set(['/index.html', '/app.js', '/style.css', '/history.html', '/history.js', '/history.css']);
const ACTIVE_STATES = new Set(['thinking', 'working', 'waiting']);
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const TEXT_MAX = 200;
const MAX_CHAIN = 16;
const ORIGIN_RETRY_MS = 30_000;
const TITLE_MAX = 80;
const TITLE_REFRESH_MS = 15_000;
const TITLE_AFTER_STOP_MS = 5_000; // 自动标题通常在一轮结束前后才写入
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_AFTER_STOP_GUARD_MS = 3000; // 异步 hook 可能乱序：Stop 之后刚到的工具事件属于上一轮
const PRUNE_MS = 24 * 60 * 60 * 1000;
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);
const TAILSCALE_BINS = ['tailscale', 'C:/Program Files/Tailscale/tailscale.exe', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

const str = (v, max) => (typeof v === 'string' && v ? Array.from(v).slice(0, max).join('') : null);
const projectOf = (cwd) => (cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd : '未知目录');

/** 把一条 hook 事件合并进会话表。返回 true 表示有变化。纯逻辑，便于单测。 */
export function applyEvent(sessions, ev) {
  const id = ev.session_id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return false;
  const ts = Number.isFinite(ev.ts) ? ev.ts : Date.now();
  if (ev.event === 'SessionEnd') return sessions.delete(id);

  let s = sessions.get(id);
  if (!s) {
    s = { id, cwd: null, project: '未知目录', state: 'idle', task: null, tool: null, prevTool: null, startedAt: ts, turnStartedAt: null, stoppedAt: null, updatedAt: 0, todos: null, taskIds: null, chain: null, transcript: null, attention: false, autoTitle: null };
    sessions.set(id, s);
  }
  const transcript = str(ev.transcript_path, 1024);
  if (transcript?.endsWith('.jsonl')) s.transcript = transcript;
  if (ev.event === 'Origin') {
    // 进程链和 transcript 路径只供本机跳转窗口使用，不进入对外的快照
    if (Array.isArray(ev.chain)) {
      s.chain = ev.chain
        .filter((p) => Number.isInteger(p?.pid) && p.pid > 0 && typeof p.name === 'string')
        .slice(0, MAX_CHAIN)
        .map((p) => ({ pid: p.pid, name: p.name.slice(0, 64) }));
    }
    return false;
  }
  const cwd = str(ev.cwd, 1024);
  if (cwd) {
    s.cwd = cwd;
    s.project = projectOf(cwd);
  }

  // 任务进度与状态顺序无关，先合并
  if (ev.todos && Number.isInteger(ev.todos.done) && Number.isInteger(ev.todos.total)) s.todos = { done: ev.todos.done, total: ev.todos.total };
  if (ev.event === 'TaskCreated' || ev.event === 'TaskCompleted') {
    const taskId = str(ev.task_id, 128);
    if (taskId) {
      s.taskIds ??= {};
      if (ev.event === 'TaskCompleted') s.taskIds[taskId] = true;
      else s.taskIds[taskId] ??= false;
      const all = Object.values(s.taskIds);
      s.todos = { done: all.filter(Boolean).length, total: all.length };
    }
    s.updatedAt = Math.max(s.updatedAt, ts);
    return true;
  }

  if (ts < s.updatedAt) return true; // 迟到的旧事件不能把状态往回拨
  const finished = s.state === 'done' || s.state === 'error';
  const isTool = ev.event === 'PreToolUse' || ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure';
  if (isTool && finished && (ev.subagent === true || ts < (s.stoppedAt ?? 0) + TOOL_AFTER_STOP_GUARD_MS)) return true;

  switch (ev.event) {
    case 'SessionStart':
      break;
    case 'UserPromptSubmit':
      s.state = 'thinking';
      s.task = str(ev.prompt, TEXT_MAX);
      s.tool = null;
      s.prevTool = null;
      s.attention = false;
      s.turnStartedAt = ts;
      s.stoppedAt = null;
      break;
    case 'PreToolUse': {
      const tool = str(ev.tool, TEXT_MAX);
      if (s.tool && s.tool !== tool) s.prevTool = s.tool; // PostToolUse 迟到被丢弃时也不丢上一步
      s.state = BLOCKING_TOOLS.has(ev.tool_name) ? 'waiting' : 'working';
      s.tool = tool;
      s.attention = false;
      s.turnStartedAt ??= ts;
      s.stoppedAt = null;
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      s.prevTool = str(ev.tool, TEXT_MAX) ?? s.tool ?? s.prevTool;
      s.state = 'thinking';
      s.tool = null;
      break;
    case 'Notification':
      if (ev.notification_type === 'idle_prompt') {
        if (!finished && s.state !== 'idle') {
          s.state = 'waiting';
          s.tool = '等你回复';
        }
      } else if (!ev.notification_type || WAITING_NOTIFICATIONS.has(ev.notification_type)) {
        s.state = 'waiting';
        s.tool = str(ev.message, TEXT_MAX) ?? '等你确认';
      } else {
        return false;
      }
      break;
    case 'Stop':
      s.state = 'done';
      s.tool = null;
      s.stoppedAt = ts;
      s.attention = true;
      break;
    case 'StopFailure':
      s.state = 'error';
      s.tool = str(ev.message, TEXT_MAX);
      s.stoppedAt = ts;
      s.attention = true;
      break;
    default:
      return false;
  }
  s.updatedAt = ts;
  return true;
}

export function pruneSessions(sessions, now = Date.now()) {
  let changed = false;
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > PRUNE_MS) changed = sessions.delete(id) || changed;
  }
  return changed;
}

/** 用户自己改的标题。单独存放：会话卡片 24 小时后会被清理，历史里还要继续显示。 */
export function normalizeTitle(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TypeError('invalid title');
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? Array.from(clean).slice(0, TITLE_MAX).join('') : null;
}

function loadTitles(file) {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))).filter(([id, title]) => ID_RE.test(id) && typeof title === 'string'));
  } catch {
    return new Map();
  }
}

function loadState(file) {
  const sessions = new Map();
  try {
    for (const s of JSON.parse(readFileSync(file, 'utf8'))) {
      if (s && typeof s.id === 'string' && ID_RE.test(s.id)) sessions.set(s.id, s);
    }
  } catch {}
  return sessions;
}

function tailscaleIp(bins = TAILSCALE_BINS) {
  return new Promise((resolve) => {
    if (!bins.length) return resolve(null);
    execFile(bins[0], ['ip', '-4'], { timeout: 3000, windowsHide: true }, (err, out) => {
      const ip = !err && String(out).trim().split(/\s+/)[0];
      if (ip && /^100\.\d+\.\d+\.\d+$/.test(ip)) resolve(ip);
      else tailscaleIp(bins.slice(1)).then(resolve);
    });
  });
}

export function startServer({ tailscale = false, onShutdown = () => process.exit(0) } = {}) {
  const PORT = configuredPort();
  const stateFile = join(dataDir(), 'state.json');
  const sessions = loadState(stateFile);
  const titlesFile = join(dataDir(), 'titles.json');
  const titles = loadTitles(titlesFile);
  const titleChecked = new Map();
  const streams = new Set();
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const info = { tailscaleUrl: null };
  let saveTimer = null;
  let pushTimer = null;
  const listeners = new Set();

  const snapshot = () => JSON.stringify({ now: Date.now(), platform: process.platform, sessions: [...sessions.values()].map(({ taskIds, chain, transcript, autoTitle, ...rest }) => ({ ...rest, title: titles.get(rest.id) ?? autoTitle ?? null })) });
  const originAsked = new Map();
  /** 这个会话还没有进程链时，让 hook 查一次（查询要启动 PowerShell，不能每个事件都做）。 */
  const needsOrigin = (id) => {
    const s = sessions.get(id);
    if (!s || s.chain) return false;
    if (Date.now() - (originAsked.get(id) ?? 0) < ORIGIN_RETRY_MS) return false;
    originAsked.set(id, Date.now());
    return true;
  };
  const save = () => {
    saveTimer = null;
    try {
      mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...sessions.values()]), { mode: 0o600 });
      renameSync(tmp, stateFile);
    } catch (e) {
      console.error(`[${APP_ID}] save failed`, e);
    }
  };
  const changed = () => {
    saveTimer ??= setTimeout(save, 1000);
    pushTimer ??= setTimeout(() => {
      pushTimer = null;
      const data = snapshot();
      for (const res of streams) res.write(`data: ${data}\n\n`);
      for (const fn of listeners) fn(sessions);
    }, 100);
  };

  const saveTitles = () => {
    try {
      mkdirSync(dirname(titlesFile), { recursive: true, mode: 0o700 });
      const tmp = `${titlesFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(titles)), { mode: 0o600 });
      renameSync(tmp, titlesFile);
    } catch (e) {
      console.error(`[${APP_ID}] save titles failed`, e);
    }
  };
  const refreshTitle = async (id) => {
    const s = sessions.get(id);
    if (!s?.transcript) return;
    const title = await readTitle(s.transcript);
    if (title && sessions.get(id) === s && s.autoTitle !== title) {
      s.autoTitle = title;
      changed();
    }
  };
  const maybeRefreshTitle = (ev) => {
    const id = ev.session_id;
    if (!sessions.has(id)) return;
    const stopped = ev.event === 'Stop' || ev.event === 'StopFailure';
    if (!stopped && Date.now() - (titleChecked.get(id) ?? 0) < TITLE_REFRESH_MS) return;
    titleChecked.set(id, Date.now());
    refreshTitle(id);
    if (stopped) setTimeout(() => refreshTitle(id), TITLE_AFTER_STOP_MS).unref();
  };

  const send = (res, status, body = '', type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const writeAllowed = (req) => {
    if (!isLoopback(req)) return false;
    const origin = req.headers.origin;
    return !origin || origin === `http://${req.headers.host}`;
  };
  const isJson = (req) => String(req.headers['content-type']).startsWith('application/json');

  const readBody = (req, res, onBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(res, 413, 'too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try {
        onBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        send(res, 400, 'invalid json');
      }
    });
  };

  const handler = (req, res) => {
    if (!hosts.has(req.headers.host)) return send(res, 403, 'forbidden'); // 防 DNS rebinding
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/api/event') {
      if (!writeAllowed(req) || !isJson(req)) return send(res, 403, 'forbidden');
      readBody(req, res, (ev) => {
        if (applyEvent(sessions, ev)) changed();
        else if (ev.event === 'Origin') saveTimer ??= setTimeout(save, 1000);
        maybeRefreshTitle(ev);
        if (ev.event !== 'Origin' && needsOrigin(ev.session_id)) send(res, 200, '{"needOrigin":true}', 'application/json; charset=utf-8');
        else send(res, 204);
      });
      return;
    }
    const sessionAction = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,128})\/(ack|title)$/);
    if (sessionAction) {
      if (!writeAllowed(req) || !isJson(req)) return send(res, 403, 'forbidden');
      const [, id, action] = sessionAction;
      if (action === 'ack' && req.method === 'POST') {
        const s = sessions.get(id);
        if (s?.attention) {
          s.attention = false;
          changed();
        }
        return send(res, 204);
      }
      if (action === 'title' && req.method === 'PUT') {
        readBody(req, res, ({ title }) => {
          const next = normalizeTitle(title);
          if (next) titles.set(id, next);
          else titles.delete(id);
          saveTitles();
          changed();
          send(res, 204);
        });
        return;
      }
      return send(res, 405, 'method not allowed');
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      if (!writeAllowed(req) || !isJson(req)) return send(res, 403, 'forbidden');
      send(res, 204);
      setTimeout(onShutdown, 50);
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
      if (!writeAllowed(req)) return send(res, 403, 'forbidden');
      if (sessions.delete(decodeURIComponent(url.pathname.slice('/api/sessions/'.length)))) changed();
      return send(res, 204);
    }
    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ app: APP_ID, tailscaleUrl: info.tailscaleUrl }), 'application/json; charset=utf-8');
    if (url.pathname === '/api/sessions') return send(res, 200, snapshot(), 'application/json; charset=utf-8');
    if (url.pathname === '/api/history') {
      // 历史里有完整对话的摘录，只给本机看，不随 --tailscale 开放
      if (!isLoopback(req)) return send(res, 403, 'forbidden');
      scanHistory(claudeDir()).then(
        (rows) => {
          const now = Date.now();
          const active = (id) => {
            const s = sessions.get(id);
            return Boolean(s && ACTIVE_STATES.has(s.state) && now - s.updatedAt < ACTIVE_WINDOW_MS);
          };
          send(res, 200, JSON.stringify({ now, platform: process.platform, sessions: rows.map((r) => ({ ...r, title: titles.get(r.id) ?? r.title, active: active(r.id) })) }), 'application/json; charset=utf-8');
        },
        () => send(res, 500, 'history unavailable'),
      );
      return;
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${snapshot()}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!STATIC.has(path)) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    createReadStream(join(PUBLIC, path.slice(1))).pipe(res);
  };

  const local = createServer(handler);
  const ready = new Promise((resolve, reject) => {
    local.once('error', reject);
    local.listen(PORT, '127.0.0.1', resolve);
  });

  // Tailscale 可能晚于本服务启动，绑定成功前定期重试
  let tailnet = null;
  const bindTailscale = async () => {
    if (tailnet) return;
    const ip = await tailscaleIp();
    if (!ip) return;
    const srv = createServer(handler);
    srv.once('error', () => {});
    srv.listen(PORT, ip, () => {
      tailnet = srv;
      hosts.add(`${ip}:${PORT}`);
      info.tailscaleUrl = `http://${ip}:${PORT}/`;
      for (const fn of listeners) fn(sessions);
    });
  };
  const timers = [
    setInterval(() => {
      for (const res of streams) res.write(': ping\n\n');
      if (pruneSessions(sessions)) changed();
    }, 25_000),
  ];
  if (tailscale) {
    bindTailscale();
    timers.push(setInterval(bindTailscale, 60_000));
  }

  return {
    port: PORT,
    ready,
    info,
    onChange: (fn) => listeners.add(fn),
    getSession: (id) => sessions.get(id),
    close() {
      timers.forEach(clearInterval);
      for (const res of streams) res.end();
      if (saveTimer) {
        clearTimeout(saveTimer);
        save();
      }
      local.close();
      tailnet?.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = startServer({
    tailscale: process.env.CLAUDE_SESSION_CARDS_TAILSCALE === '1',
    onShutdown: () => {
      server.close();
      process.exit(0);
    },
  });
  server.ready.catch((err) => {
    console.error(`[${APP_ID}] start failed`, err);
    process.exit(1);
  });
}
