'use strict';

const host = window.overlay; // 只有桌面置顶窗口才有（preload 注入）
const STALE_MS = 30 * 60 * 1000; // 进行中却这么久没事件：可能被强杀或中断
const DONE_VISIBLE_MS = 2 * 60 * 60 * 1000;
const TITLE_MAX = 80;
const TIP_DELAY_MS = 500;
const LABEL = { waiting: '等你确认', error: '出错', working: '执行中', thinking: '思考中', stale: '可能已中断', done: '已完成', idle: '空闲' };
const ORDER = ['waiting', 'error', 'working', 'thinking', 'stale', 'done', 'idle'];

const $ = (id) => document.getElementById(id);
const cardsEl = $('cards');
const tipEl = $('tip');
let sessions = [];
let clockOffset = 0;
let hostPlatform = 'win32';
let editingId = null;
let usageTotals = null;
let usageLimits = null;
const cardNodes = new Map(); // 会话 ID -> { signature, node }

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

// 未确认的完成提示排在进行中的卡片前面
const rank = ({ s, state }) => (state === 'done' && s.attention ? 1.5 : ORDER.indexOf(state));

function visible() {
  return sessions
    .map((s) => ({ s, state: viewState(s) }))
    .filter(({ s, state }) => s.attention || !((state === 'done' || state === 'idle') && now() - s.updatedAt > DONE_VISIBLE_MS))
    .sort((a, b) => rank(a) - rank(b) || b.s.updatedAt - a.s.updatedAt);
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
  return navigator.clipboard.writeText(text);
}

// 桌面窗口不用原生 title：点击穿透后窗口收不到鼠标事件，原生提示框会一直留在屏幕上
function setTip(node, text) {
  if (host) node.dataset.tip = text;
  else node.title = text;
}

let tipTarget = null;
let tipTimer = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (tipEl.hidden) return;
  tipEl.hidden = true;
  reportSize();
}

/** 窗口顶部到屏幕底部的距离，换算成页面坐标。 */
function screenRoomBelow() {
  const factor = (host && SCALE[appearance.size]) || 1;
  return (window.screen.availTop + window.screen.availHeight - window.screenY) / factor;
}

function showTip(target) {
  if (!target.isConnected || editingId || !$('menu').hidden) return;
  tipEl.textContent = target.dataset.tip;
  tipEl.hidden = false;
  const rect = target.getBoundingClientRect();
  const available = screenRoomBelow() - 8;
  const height = tipEl.offsetHeight;
  const below = rect.bottom + 4;
  tipEl.style.top = `${below + height <= available ? below : Math.max(4, rect.top - height - 4)}px`;
  reportSize();
}

function notice(card, text, ms = 2000) {
  card.dataset.notice = text;
  clearTimeout(card.noticeTimer);
  if (ms) card.noticeTimer = setTimeout(() => delete card.dataset.notice, ms);
}

async function copyResume(card, s) {
  try {
    await copyText(resumeCommand(s));
    notice(card, '已复制恢复命令', 1200);
  } catch {
    window.prompt('复制恢复命令', resumeCommand(s));
  }
}

async function jumpToWindow(card, s) {
  notice(card, '正在跳转…', 0);
  const result = await host.focusSession(s.id);
  if (result === 'focused') delete card.dataset.notice;
  else if (result === 'opened') notice(card, '已在新标签页恢复');
  else if (result === 'unsupported') copyResume(card, s);
  else if (result === 'refused') notice(card, '系统拦截了窗口切换，请手动切换');
  else if (result === 'running') notice(card, '会话还在运行，但找不到它的窗口');
  else if (result === 'no-dir') notice(card, '目录已不存在，无法恢复');
  else notice(card, '找不到这个会话的记录');
}

function acknowledge(card, s) {
  if (!s.attention) return;
  s.attention = false;
  card.classList.remove('attention');
  updateBarAttention();
  fetch(`/api/sessions/${encodeURIComponent(s.id)}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

function startEditing(card, s) {
  hideTip();
  editingId = s.id;
  const input = el('input', 'title-input');
  input.value = s.title ?? '';
  input.placeholder = s.project;
  input.maxLength = TITLE_MAX;
  input.setAttribute('aria-label', '会话标题');
  card.querySelector('.project').replaceWith(input);
  reportSize();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    editingId = null;
    host.setEditing(false);
    cardNodes.delete(s.id); // 下一次渲染重建，换回普通标题
    if (save && input.value.trim() !== (s.title ?? '')) {
      s.title = input.value.trim() || null;
      await fetch(`/api/sessions/${encodeURIComponent(s.id)}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.value }),
      });
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    // 输入法选词时的回车和 Esc 属于输入法，不是提交或取消
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  host.setEditing(true).then(() => {
    input.focus();
    input.select();
    // 拿到焦点之后才监听失焦，切换窗口过程中的短暂失焦不算结束
    input.addEventListener('blur', () => finish(true));
  });
}

/** claude-opus-5-5 -> Opus 5.5；认不出的原样显示。 */
function modelName(model) {
  const match = model?.match(/^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-|$)/);
  if (!match) return model ?? null;
  const name = match[1][0].toUpperCase() + match[1].slice(1);
  return `${name} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

function buildCard({ s, state }) {
  const card = el('article', `card ${state}`);
  card.dataset.id = s.id;
  const hint = host ? '单击确认完成提示，双击跳转到窗口（已关闭则重新打开），右键更多操作' : '点击复制恢复命令';
  setTip(card, [s.title, s.cwd, s.task, s.tool, s.prevTool && `上一步：${s.prevTool}`, hint].filter(Boolean).join('\n'));

  const head = el('div', 'head');
  const heading = el('div', 'project', s.title ?? s.project);
  if (!s.title) heading.append(' ', el('span', 'short', s.id.slice(0, 4)));
  const status = el('span', 'status');
  status.append(el('span', 'dot'), LABEL[state] ?? state);
  head.append(heading, status);
  card.append(head);
  const model = modelName(s.model);
  const sub = s.title ? [s.project, s.id.slice(0, 4), model] : [model];
  if (sub.some(Boolean)) card.append(el('div', 'sub', sub.filter(Boolean).join(' · ')));

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
  foot.append(el('span', 'time', timeText(s, state)));
  card.append(foot);

  if (host) {
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const copy = (text, label) => async () => {
        await host.copy(text);
        notice(card, label, 1200);
      };
      openMenu(e, [
        { label: '修改标题', action: () => startEditing(card, s) },
        { label: '跳转到窗口', action: () => jumpToWindow(card, s) },
        { label: '复制恢复命令', action: copy(resumeCommand(s), '已复制恢复命令') },
        { label: '复制会话 ID', action: copy(s.id, '已复制会话 ID') },
        { label: '移除这张卡片', action: () => fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }) },
      ]);
    });
    const dismiss = el('button', 'dismiss', '×');
    dismiss.type = 'button';
    setTip(dismiss, '移除这张卡片');
    dismiss.setAttribute('aria-label', '移除这张卡片');
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    });
    card.append(dismiss);
  }
  return card;
}

// 点击放在容器上：两次点击之间卡片可能被重建，绑在卡片上双击会失效
function sessionOfEvent(e) {
  if (e.target.closest('input, button')) return null;
  const card = e.target.closest('.card');
  const s = card && sessions.find((x) => x.id === card.dataset.id);
  return s ? { card, s } : null;
}
cardsEl.addEventListener('click', (e) => {
  const hit = sessionOfEvent(e);
  if (!hit) return;
  if (host) acknowledge(hit.card, hit.s);
  else copyResume(hit.card, hit.s); // 浏览器页面没有跳转窗口的能力
});
cardsEl.addEventListener('dblclick', (e) => {
  const hit = sessionOfEvent(e);
  if (hit && host) jumpToWindow(hit.card, hit.s);
});

function updateBarAttention() {
  const collapsed = document.body.classList.contains('collapsed');
  $('bar').classList.toggle('attention', collapsed && sessions.some((s) => s.attention));
}

/** 只更新变化的卡片：整体重建会打断进行中的点击、悬停和标题编辑。 */
function renderCards(items) {
  if (!items.length) {
    cardNodes.clear();
    cardsEl.replaceChildren(el('div', 'empty', '还没有会话，新开的 Claude Code 会话会出现在这里'));
    return;
  }
  const nodes = items.map((item) => {
    const { s, state } = item;
    const signature = JSON.stringify([state, s.title, s.model, s.project, s.task, s.tool, s.prevTool, s.todos, s.cwd]);
    let entry = cardNodes.get(s.id);
    if (!entry || (entry.signature !== signature && editingId !== s.id)) {
      entry = { signature, node: buildCard(item) };
      cardNodes.set(s.id, entry);
    }
    entry.node.classList.toggle('attention', Boolean(s.attention));
    entry.node.querySelector('.time').textContent = timeText(s, state);
    return entry.node;
  });
  const keep = new Set(items.map((item) => item.s.id));
  for (const id of cardNodes.keys()) if (!keep.has(id) && id !== editingId) cardNodes.delete(id);
  if (editingId) {
    // 移动 DOM 节点会让输入框失去焦点，把正在改的标题提交掉：编辑期间不调整顺序
    for (const node of nodes) if (!node.isConnected) cardsEl.append(node);
    return;
  }
  nodes.forEach((node, index) => {
    if (cardsEl.children[index] !== node) cardsEl.insertBefore(node, cardsEl.children[index] ?? null);
  });
  while (cardsEl.children.length > nodes.length) cardsEl.lastElementChild.remove();
}

function render() {
  const items = visible();
  const counts = $('counts');
  counts.replaceChildren();
  for (const state of ORDER) {
    const n = items.filter((i) => i.state === state).length;
    if (!n) continue;
    const chip = el('span', 'count');
    setTip(chip, LABEL[state]);
    const dot = el('span', 'dot');
    dot.style.background = `var(--${state})`;
    chip.append(dot, String(n));
    counts.append(chip);
  }
  if (!items.length) counts.textContent = 'Claude 会话';
  renderCards(items);
  if (tipTarget && !tipTarget.isConnected) hideTip();
  updateBarAttention();
  $('toggle').textContent = document.body.classList.contains('collapsed') ? '▾' : '▴';
  reportSize();
}

function tokenText(value) {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (value >= 1e4) return `${Math.round(value / 1e4)}万`;
  return String(value);
}

function resetText(at) {
  if (!at) return '';
  const date = new Date(at);
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const time = date.toTimeString().slice(0, 5);
  return date.toDateString() === new Date().toDateString() ? `今天 ${time}` : `${days[date.getDay()]} ${time}`;
}

function renderUsage() {
  const box = $('usage');
  const shown = appearance.usage;
  const totalsTip = (name, t) => [
    `${name}：${t.total.toLocaleString()}（输入 + 输出 + 写入缓存）`,
    `输入 ${t.input.toLocaleString()}`,
    `输出 ${t.output.toLocaleString()}`,
    `写入缓存 ${t.cacheWrite.toLocaleString()}`,
    `读取缓存 ${t.cacheRead.toLocaleString()}（不计入）`,
    '只统计这台电脑上的记录',
  ].join('\n');
  const limitTip = (name, window) => [
    `${name}已用 ${window.percent}%`,
    window.resetsAt && `${resetText(window.resetsAt)} 重置`,
    usageLimits?.updatedAt && `数据更新于 ${new Date(usageLimits.updatedAt).toLocaleTimeString()}`,
  ].filter(Boolean).join('\n');
  const items = [];
  if (shown.today && usageTotals) items.push([`今日 ${tokenText(usageTotals.today.total)}`, totalsTip('今日', usageTotals.today)]);
  if (shown.week && usageTotals) items.push([`本周 ${tokenText(usageTotals.week.total)}`, totalsTip('本周（周一起）', usageTotals.week)]);
  for (const [key, short, name] of [['fiveHour', '5h', '5 小时限额'], ['sevenDay', '7天', '7 天限额']]) {
    const window = usageLimits?.[key];
    if (!shown[key] || !window) continue;
    const level = window.percent >= 95 ? 'danger' : window.percent >= 80 ? 'warn' : '';
    items.push([`${short} ${Math.round(window.percent)}%`, limitTip(name, window), level]);
  }
  box.replaceChildren(...items.map(([text, tip, level]) => {
    const node = el('span', level ?? '', text);
    setTip(node, tip);
    return node;
  }));
  box.hidden = items.length === 0;
  $('bar').classList.toggle('has-usage', items.length > 0);
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
    usageTotals = data.usage;
    usageLimits = data.limits;
    renderUsage();
    render();
  };
}

let lastHeight = 0;
let lastMenuHidden = true;
function reportSize() {
  if (!host) return;
  // 用内容高度而不是 #root 的实际高度：窗口到上限后 #root 被 100vh 限住，量它就再也长不回来
  const collapsed = document.body.classList.contains('collapsed');
  const content = $('bar').getBoundingClientRect().height + (collapsed ? 0 : 6 + cardsEl.scrollHeight);
  const menu = $('menu');
  const height = Math.ceil(Math.max(
    content,
    menu.hidden ? 0 : menu.offsetTop + menu.offsetHeight + 4,
    tipEl.hidden ? 0 : tipEl.offsetTop + tipEl.offsetHeight + 4,
  ));
  if (height !== lastHeight || menu.hidden === lastMenuHidden) {
    lastHeight = height;
    lastMenuHidden = !menu.hidden;
    host.resize(height, !menu.hidden);
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
  // 鼠标离开窗口：穿透状态下 mouseleave 不一定收得到，所以主进程也会按光标位置通知
  const pointerLeft = () => {
    if (!dragging) setInteractive(false);
    hideTip();
    closeMenu(); // 窗口不抢焦点，收不到“点到别处”，只能以鼠标离开为准
  };
  document.documentElement.addEventListener('mouseleave', pointerLeft);
  host.onPointerLeft(pointerLeft);
  document.addEventListener('pointerdown', (e) => {
    hideTip();
    if (!e.target.closest?.('#menu')) closeMenu();
  }, true);
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest?.('[data-tip]') ?? null;
    if (target === tipTarget) return;
    hideTip();
    tipTarget = target;
    if (target) tipTimer = setTimeout(() => showTip(target), TIP_DELAY_MS);
  });
  cardsEl.addEventListener('scroll', hideTip);
  for (const id of ['new', 'history', 'toggle']) {
    const button = $(id);
    setTip(button, button.title);
    button.removeAttribute('title');
  }

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

const USAGE_ITEMS = [['today', '今日用量'], ['week', '本周用量'], ['fiveHour', '5 小时限额'], ['sevenDay', '7 天限额']];
const SIZES = [['small', '小'], ['standard', '标准'], ['large', '大']];
const SCALE = { small: 0.85, standard: 1, large: 1.2 };
const THEMES = [['system', '跟随系统'], ['dark', '深色'], ['light', '浅色']];
const OPACITIES = [['opaque', '不透明'], ['standard', '标准'], ['translucent', '较透明']];
let appearance = { theme: 'system', opacity: 'standard', size: 'standard', usage: { today: true, week: true, fiveHour: true, sevenDay: true } };

function applyAppearance(next) {
  appearance = next;
  document.documentElement.dataset.opacity = appearance.opacity;
  renderUsage();
}

function renderMenu(entries, x, y) {
  hideTip();
  const menu = $('menu');
  menu.replaceChildren(...entries.map(({ label, action, separated, stay }) => {
    const button = el('button', separated ? 'separated' : '', label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!stay) closeMenu();
      action();
    });
    return button;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  // 优先往上收；窗口本身离底部太近时，由主进程临时上移窗口
  const available = screenRoomBelow();
  menu.style.top = `${Math.max(4, Math.min(y, available - menu.offsetHeight - 12))}px`;
  reportSize();
}

async function openMenu(e, items) {
  const { clientX: x, clientY: y } = e;
  const [pinned, autostart] = await Promise.all([host.getPinned(), host.getAutostart()]);
  const main = () => {
    const submenu = (label, options, key) => ({
      label: `${label} ▸`,
      stay: true,
      action: () => renderMenu([
        { label: '‹ 返回', stay: true, action: main },
        ...options.map(([value, name]) => ({
          label: `${appearance[key] === value ? '✓ ' : ''}${name}`,
          action: () => {
            applyAppearance({ ...appearance, [key]: value });
            host.setAppearance(appearance);
          },
          separated: value === options[0][0],
        })),
      ], x, y),
    });
    renderMenu([
      ...items,
      { label: `${pinned ? '✓ ' : ''}窗口置顶`, action: () => host.setPinned(!pinned), separated: items.length > 0 },
      ...(autostart === null ? [] : [{ label: `${autostart ? '✓ ' : ''}开机自启`, action: () => host.setAutostart(!autostart) }]),
      submenu('外观', THEMES, 'theme'),
      submenu('透明度', OPACITIES, 'opacity'),
      submenu('大小', SIZES, 'size'),
      {
        label: '用量显示 ▸',
        stay: true,
        action: function usageMenu() {
          renderMenu([
            { label: '‹ 返回', stay: true, action: main },
            ...USAGE_ITEMS.map(([key, name], index) => ({
              label: `${appearance.usage[key] ? '✓ ' : ''}${name}`,
              stay: true,
              separated: index === 0,
              action: () => {
                applyAppearance({ ...appearance, usage: { ...appearance.usage, [key]: !appearance.usage[key] } });
                host.setAppearance(appearance);
                usageMenu();
              },
            })),
          ], x, y);
        },
      },
    ], x, y);
  };
  main();
}

if (host) host.getAppearance().then(applyAppearance);

// 同名目录要带上上级才分得清
function dirLabels(dirs) {
  const parts = dirs.map((dir) => dir.replace(/[\\/]+$/, '').split(/[\\/]/));
  const name = (p) => p.at(-1) || p.join('/');
  return parts.map((p) => {
    const same = parts.filter((other) => name(other) === name(p)).length > 1;
    return same && p.length > 1 ? `${p.at(-2)}/${name(p)}` : name(p);
  });
}

if (host) {
  host.recentDirs().then((dirs) => { $('new').hidden = dirs === null; });
  $('new').addEventListener('click', async (e) => {
    e.stopPropagation();
    const { clientX: x, clientY: y } = e;
    const dirs = (await host.recentDirs()) ?? [];
    const labels = dirLabels(dirs);
    renderMenu([
      ...dirs.map((dir, index) => ({ label: labels[index], action: () => host.newSession(dir) })),
      { label: '选择其他目录…', action: () => host.pickDirectory(), separated: dirs.length > 0 },
    ], x, y);
  });
}

if (host) {
  $('bar').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu(e, []);
  });
}

$('history').addEventListener('click', (e) => {
  e.stopPropagation();
  if (host) host.openHistory();
  else location.href = '/history.html';
});

render();
connect();
setInterval(render, 1000);
