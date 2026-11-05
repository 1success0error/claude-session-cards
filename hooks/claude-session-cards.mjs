// Claude Code hook：把事件按会话上报给本地卡片服务。服务没开就静默跳过。
// 只上报描述性字段，不上报命令原文；URL 去掉查询串，避免把 token 带出去。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const port = Number(process.env.CLAUDE_SESSION_CARDS_PORT) || 47831;
const URL_EVENT = `http://127.0.0.1:${port}/api/event`;
const TEXT_MAX = 120;

const clip = (s) => {
  const chars = Array.from(String(s ?? '').replace(/<\/?pasted_content\b[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : chars.join('');
};

function toolLabel(name, input) {
  const detail = input.description
    || (input.file_path && basename(input.file_path))
    || (input.notebook_path && basename(input.notebook_path))
    || input.pattern || input.query || input.skill
    || (input.url && String(input.url).split(/[?#]/)[0])
    || '';
  return clip(detail ? `${name}: ${detail}` : name);
}

const post = (body) => fetch(URL_EVENT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(1500),
});

/** 从本进程往上的进程链，点击卡片时据此找到所在的终端窗口。目前只支持 Windows。 */
function processChain() {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)" }';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  const table = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [pid, parent, name] = line.split('\t');
    if (name) table.set(Number(pid), { parent: Number(parent), name });
  }
  const chain = [];
  const seen = new Set();
  for (let pid = process.ppid; table.has(pid) && !seen.has(pid) && chain.length < 16; pid = table.get(pid).parent) {
    seen.add(pid);
    chain.push({ pid, name: table.get(pid).name });
  }
  return chain;
}

async function main() {
  const ts = Date.now();
  const ev = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (!ev.session_id || !ev.hook_event_name) return;
  const input = ev.tool_input ?? {};
  const res = await post({
    event: ev.hook_event_name,
    session_id: ev.session_id,
    cwd: ev.cwd,
    ts,
    prompt: ev.prompt === undefined ? undefined : clip(ev.prompt),
    tool_name: ev.tool_name,
    tool: ev.tool_name ? toolLabel(ev.tool_name, input) : undefined,
    subagent: Boolean(ev.agent_id),
    notification_type: ev.notification_type,
    message: ev.message === undefined ? undefined : clip(ev.message),
    task_id: ev.task_id,
    todos: Array.isArray(input.todos)
      ? { done: input.todos.filter((t) => t?.status === 'completed').length, total: input.todos.length }
      : undefined,
  });
  if (res.status === 200 && process.platform === 'win32' && (await res.json()).needOrigin) {
    await post({ event: 'Origin', session_id: ev.session_id, chain: processChain(), transcript_path: ev.transcript_path });
  }
}

main().catch(() => {}).finally(() => process.exit(0));
