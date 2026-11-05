'use strict';

const host = window.overlay; // 只有桌面程序里才能打开终端；网页里退回复制命令
const DAY_MS = 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
let rows = [];
let platform = 'win32';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const setSummary = (text, isError = false) => {
  $('summary').textContent = text;
  $('summary').classList.toggle('error', isError);
};

function resumeCommand(s) {
  const resume = `claude --resume ${s.id}`;
  if (!s.cwd) return resume;
  if (platform === 'win32') return `cd "${s.cwd}"; ${resume}`;
  return `cd '${s.cwd.replaceAll("'", `'"'"'`)}' && ${resume}`;
}

async function copyText(text, label) {
  try {
    if (host) await host.copy(text);
    else await navigator.clipboard.writeText(text);
    setSummary(`${label}已复制`);
  } catch {
    setSummary(`复制失败：${text}`, true);
  }
}

async function resume(s) {
  if (!host) return copyText(resumeCommand(s), '恢复命令');
  setSummary('正在打开…');
  const result = await host.resumeSession(s.id);
  if (result === 'opened') setSummary(`已在新标签页恢复：${s.title ?? s.id}`);
  else if (result === 'focused') setSummary(`这个会话还开着，已切换到它的窗口：${s.title ?? s.id}`);
  else if (result === 'running') setSummary(`这个会话还在运行，但找不到它的窗口，为避免冲突没有新开：${s.title ?? s.id}`, true);
  else if (result === 'refused') setSummary('系统拦截了窗口切换，请手动切换', true);
  else if (result === 'no-dir') setSummary(`目录已不存在，无法恢复：${s.cwd ?? '未知目录'}`, true);
  else if (result === 'unsupported') copyText(resumeCommand(s), '恢复命令');
  else setSummary('找不到这个会话，可能已被清理，请刷新', true);
}

function closeMenu() {
  $('menu').hidden = true;
}

function openMenu(e, s) {
  e.preventDefault();
  const menu = $('menu');
  const items = [
    ['恢复会话', () => resume(s)],
    ['复制恢复命令', () => copyText(resumeCommand(s), '恢复命令')],
    ['复制会话 ID', () => copyText(s.id, '会话 ID')],
  ];
  menu.replaceChildren(...items.map(([label, action]) => {
    const button = el('button', '', label);
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      closeMenu();
      action();
    });
    return button;
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4))}px`;
  menu.querySelector('button').focus();
}

function ago(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function groupOf(mtime, startOfToday) {
  if (mtime >= startOfToday) return '今天';
  if (mtime >= startOfToday - DAY_MS) return '昨天';
  if (mtime >= startOfToday - 6 * DAY_MS) return '最近 7 天';
  return '更早';
}

function buildRow(s, now) {
  const row = el('button', 'row');
  row.type = 'button';
  row.title = [s.cwd, s.prompt, '点击恢复，右键更多操作'].filter(Boolean).join('\n');

  const title = el('div', 'title');
  title.append(el('span', '', s.title ?? s.prompt ?? '（无标题）'));
  if (s.active) title.append(el('span', 'badge', '运行中'));
  row.append(title);
  if (s.title && s.prompt) row.append(el('div', 'prompt', s.prompt));
  row.append(el('div', 'meta', [s.cwd ?? '未知目录', ago(now - s.mtime), sizeText(s.size)].join(' · ')));

  row.addEventListener('click', () => resume(s));
  row.addEventListener('contextmenu', (e) => openMenu(e, s));
  return row;
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const project = $('project').value;
  const shown = rows.filter((s) => {
    if (project && s.project !== project) return false;
    if (!query) return true;
    return [s.title, s.prompt, s.cwd, s.id].some((v) => v?.toLowerCase().includes(query));
  });

  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nodes = [];
  let lastGroup = null;
  for (const s of shown) {
    const group = groupOf(s.mtime, today.getTime());
    if (group !== lastGroup) {
      nodes.push(el('div', 'group', group));
      lastGroup = group;
    }
    nodes.push(buildRow(s, now));
  }
  if (!nodes.length) nodes.push(el('div', 'empty', rows.length ? '没有符合条件的会话' : '还没有历史会话'));
  $('list').replaceChildren(...nodes);
  setSummary(shown.length === rows.length ? `共 ${rows.length} 个会话` : `显示 ${shown.length} / ${rows.length} 个会话`);
}

function fillProjects() {
  const select = $('project');
  const current = select.value;
  const projects = [...new Set(rows.map((s) => s.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const all = el('option', '', '全部项目');
  all.value = '';
  select.replaceChildren(all, ...projects.map((name) => {
    const option = el('option', '', name);
    option.value = name;
    return option;
  }));
  select.value = projects.includes(current) ? current : '';
}

async function load() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    rows = data.sessions;
    platform = data.platform;
    fillProjects();
    render();
  } catch {
    setSummary('读取历史失败。历史会话只能在运行本工具的电脑上查看。', true);
  }
}

$('search').addEventListener('input', render);
$('project').addEventListener('change', render);
$('refresh').addEventListener('click', load);
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#menu')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('focus', load); // 切回窗口时刷新，运行状态和新会话才是最新的

load();
