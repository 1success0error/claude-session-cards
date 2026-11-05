'use strict';

const host = window.overlay; // 只有桌面置顶窗口才有（preload 注入）
const STALE_MS = 30 * 60 * 1000; // 进行中却这么久没事件：可能被强杀或中断
const DONE_VISIBLE_MS = 2 * 60 * 60 * 1000;
const LABEL = { waiting: '等你确认', error: '出错', working: '执行中', thinking: '思考中', stale: '可能已中断', done: '已完成', idle: '空闲' };
const ORDER = ['waiting', 'error', 'working', 'thinking', 'stale', 'done', 'idle'];

const $ = (id) => document.getElementById(id);
const cardsEl = $('cards');
let sessions = [];
let clockOffset = 0;
let hostPlatform = 'win32';
let lastSignature = null;

if (host) document.documentElement.classList.add('overlay');

const now = () => Date.now() + clockOffset;
const viewState = (s) => ((s.state === 'working' || s.state === 'thinking') && now() - s.updatedAt > STALE_MS ? 'stale' : s.state);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function duration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分钟`;
}

function timeText(s, state) {
  if (state === 'done' || state === 'error') return `${duration(now() - (s.stoppedAt ?? s.updatedAt))}前结束`;
  if (state === 'stale' || state === 'idle') return `${duration(now() - s.updatedAt)}前活动`;
  return `已运行 ${duration(now() - (s.turnStartedAt ?? s.startedAt))}`;
}

function visible() {
  return sessions
    .map((s) => ({ s, state: viewState(s) }))
    .filter(({ s, state }) => !((state === 'done' || state === 'idle') && now() - s.updatedAt > DONE_VISIBLE_MS))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.s.updatedAt - a.s.updatedAt);
}

// Windows 按 PowerShell 写（5.1 不支持 &&）；其他平台按 POSIX shell 引用路径
function resumeCommand(s) {
  const resume = `claude --resume ${s.id}`;
  if (!s.cwd) return resume;
  if (hostPlatform === 'win32') return `cd "${s.cwd}"; ${resume}`;
  return `cd '${s.cwd.replaceAll("'", `'"'"'`)}' && ${resume}`;
}

async function copyText(text) {
  if (host) return host.copy(text);
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // 手机通过 http 访问 Tailscale 地址时不是安全上下文，退回旧接口
  const area = el('textarea');
  area.value = text;
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function buildCard({ s, state }) {
  const card = el('article', `card ${state}`);
  card.title = [s.cwd, s.task, s.tool, s.prevTool && `上一步：${s.prevTool}`, host ? '左键跳转到窗口，右键更多操作' : '点击复制恢复命令'].filter(Boolean).join('\n');

  const head = el('div', 'head');
  const project = el('div', 'project', s.project);
  project.append(' ', el('span', 'short', s.id.slice(0, 4)));
  const status = el('span', 'status');
  status.append(el('span', 'dot'), LABEL[state] ?? state);
  head.append(project, status);
  card.append(head);

  if (s.task) card.append(el('div', 'line task', s.task));
  if (s.tool) card.append(el('div', 'line tool', s.tool));
  if (s.prevTool) card.append(el('div', 'line prev', `上一步：${s.prevTool}`));

  const foot = el('div', 'foot');
  if (s.todos && s.todos.total > 0) {
    foot.append(`任务 ${s.todos.done}/${s.todos.total}`);
    const bar = el('div', 'progress');
    const fill = el('i');
    fill.style.width = `${Math.min(100, (s.todos.done / s.todos.total) * 100)}%`;
    bar.append(fill);
    foot.append(bar);
  } else {
    foot.append(el('span', 'spacer'));
  }
  const time = el('span', 'time', timeText(s, state));
  time.dataset.id = s.id;
  foot.append(time);
  card.append(foot);

  const notice = (text, ms = 2000) => {
    card.dataset.notice = text;
    clearTimeout(card.noticeTimer);
    if (ms) card.noticeTimer = setTimeout(() => delete card.dataset.notice, ms);
  };
  const copyResume = async () => {
    try {
      await copyText(resumeCommand(s));
      notice('已复制恢复命令', 1200);
    } catch {
      window.prompt('复制恢复命令', resumeCommand(s));
    }
  };

  card.addEventListener('click', async () => {
    if (!host) return copyResume(); // 手机和网页无法操作电脑上的窗口
    notice('正在跳转…', 0);
    const result = await host.focusSession(s.id);
    if (result === 'focused') delete card.dataset.notice;
    else if (result === 'unsupported') copyResume();
    else if (result === 'refused') notice('系统拦截了窗口切换，请手动切换');
    else notice('找不到对应窗口，可右键复制恢复命令');
  });
  if (host) {
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const copy = (text, label) => async () => {
        await host.copy(text);
        notice(label, 1200);
      };
      openMenu(e, [
        { label: '跳转到窗口', action: () => card.click() },
        { label: '复制恢复命令', action: copy(resumeCommand(s), '已复制恢复命令') },
        { label: '复制会话 ID', action: copy(s.id, '已复制会话 ID') },
        { label: '移除这张卡片', action: () => fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }) },
      ]);
    });
    const dismiss = el('button', 'dismiss', '×');
    dismiss.type = 'button';
    dismiss.title = '移除这张卡片';
    dismiss.setAttribute('aria-label', '移除这张卡片');
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    });
    card.append(dismiss);
  }
  return card;
}

function render() {
  const items = visible();
  const counts = $('counts');
  counts.replaceChildren();
  for (const state of ORDER) {
    const n = items.filter((i) => i.state === state).length;
    if (!n) continue;
    const chip = el('span', 'count');
    chip.title = LABEL[state];
    const dot = el('span', 'dot');
    dot.style.background = `var(--${state})`;
    chip.append(dot, String(n));
    counts.append(chip);
  }
  if (!items.length) counts.textContent = 'Claude 会话';
  // 内容没变就只刷新时间：每秒重建 DOM 会丢掉正在进行的点击和悬停状态
  const signature = JSON.stringify(items.map(({ s, state }) => [s.id, state, s.project, s.task, s.tool, s.prevTool, s.todos, s.cwd]));
  if (signature !== lastSignature) {
    lastSignature = signature;
    if (items.length) cardsEl.replaceChildren(...items.map(buildCard));
    else cardsEl.replaceChildren(el('div', 'empty', '还没有会话，新开的 Claude Code 会话会出现在这里'));
  } else {
    for (const { s, state } of items) {
      const time = cardsEl.querySelector(`.time[data-id="${CSS.escape(s.id)}"]`);
      if (time) time.textContent = timeText(s, state);
    }
  }
  $('toggle').textContent = document.body.classList.contains('collapsed') ? '▾' : '▴';
  reportSize();
}

function setCollapsed(on) {
  document.body.classList.toggle('collapsed', on);
  try { localStorage.setItem('collapsed', on ? '1' : ''); } catch {}
  render();
}
$('toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  setCollapsed(!document.body.classList.contains('collapsed'));
});
try { document.body.classList.toggle('collapsed', localStorage.getItem('collapsed') === '1'); } catch {}

function connect() {
  const stream = new EventSource('/api/stream');
  stream.onopen = () => { $('conn').hidden = true; reportSize(); };
  stream.onerror = () => { $('conn').hidden = false; reportSize(); }; // EventSource 会自动重连
  stream.onmessage = (e) => {
    const data = JSON.parse(e.data);
    clockOffset = data.now - Date.now();
    hostPlatform = data.platform;
    sessions = data.sessions;
    render();
  };
}

let lastHeight = 0;
function reportSize() {
  if (!host) return;
  // 用内容高度而不是 #root 的实际高度：窗口到上限后 #root 被 100vh 限住，量它就再也长不回来
  const collapsed = document.body.classList.contains('collapsed');
  const content = $('bar').getBoundingClientRect().height + (collapsed ? 0 : 6 + cardsEl.scrollHeight);
  const menu = $('menu');
  const height = Math.ceil(Math.max(content, menu.hidden ? 0 : menu.offsetTop + menu.offsetHeight + 4));
  if (height !== lastHeight) {
    lastHeight = height;
    host.resize(height);
  }
}

if (host) {
  // 点击穿透：光标在栏或卡片上才接收鼠标，否则事件落到下层窗口
  let interactive = false;
  let dragging = false;
  const setInteractive = (on) => {
    if (on !== interactive) {
      interactive = on;
      host.setInteractive(on);
    }
  };
  document.addEventListener('mousemove', (e) => {
    if (!dragging) setInteractive(Boolean(document.elementFromPoint(e.clientX, e.clientY)?.closest('#bar, .card, #menu')));
  });
  document.documentElement.addEventListener('mouseleave', () => {
    if (!dragging) setInteractive(false);
    closeMenu(); // 窗口不抢焦点，收不到“点到别处”，只能以鼠标离开为准
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#menu')) closeMenu();
  }, true);

  const bar = $('bar');
  let start = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    bar.setPointerCapture(e.pointerId);
    dragging = true;
    start = { x: e.screenX, y: e.screenY };
    bar.classList.add('dragging');
    host.dragStart();
  });
  bar.addEventListener('pointermove', (e) => {
    if (start) host.dragMove(e.screenX - start.x, e.screenY - start.y);
  });
  const endDrag = () => {
    if (!start) return;
    start = null;
    dragging = false;
    bar.classList.remove('dragging');
    host.dragEnd();
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

// 菜单画在页面里：窗口 focusable: false 时原生菜单弹不出来
function closeMenu() {
  const menu = $('menu');
  if (menu.hidden) return;
  menu.hidden = true;
  reportSize();
}

async function openMenu(e, items) {
  const { clientX, clientY } = e;
  const pinned = await host.getPinned();
  const menu = $('menu');
  const entries = [...items, { label: `${pinned ? '✓ ' : ''}窗口置顶`, action: () => host.setPinned(!pinned), separated: items.length > 0 }];
  menu.replaceChildren(...entries.map(({ label, action, separated }) => {
    const button = el('button', separated ? 'separated' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      action();
    });
    return button;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${clientY}px`;
  reportSize();
}

if (host) {
  $('bar').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(e, []);
  });
}

// 历史只对本机开放，手机上不显示入口
const historyButton = $('history');
historyButton.hidden = !host && !['127.0.0.1', 'localhost'].includes(location.hostname);
historyButton.addEventListener('click', (e) => {
  e.stopPropagation();
  if (host) host.openHistory();
  else location.href = '/history.html';
});

render();
connect();
setInterval(render, 1000);
