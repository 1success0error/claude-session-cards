// 可选 hook（install --dsh-pet）：把状态推给 DeepSeek Harness 的 dsh-pet 桌宠。
// DSH 端口每次启动都变：缓存到临时文件，失效时按进程名重新发现。可用 DSH_PET_URL 覆盖。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const PREFIX = '/dsh-pet-7340';
const CACHE = join(tmpdir(), 'dsh-pet-port.txt');
const TEXT_MAX = 40;

const clip = (s) => {
  const chars = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > TEXT_MAX ? `${chars.slice(0, TEXT_MAX - 1).join('')}…` : chars.join('');
};

function toolTask(name, input = {}) {
  const detail = input.description || (input.file_path && basename(input.file_path)) || input.pattern || (input.url && String(input.url).split(/[?#]/)[0]) || '';
  return clip(detail ? `${name}: ${detail}` : name);
}

function mapEvent(ev) {
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit': return { state: 'thinking', task: clip(`CC: ${ev.prompt ?? ''}`) };
    case 'PreToolUse': return { state: 'working', task: toolTask(ev.tool_name, ev.tool_input) };
    case 'Notification': return { state: 'waiting', task: clip(ev.message || 'Claude Code 等你回复') };
    case 'Stop': return { state: 'success', task: 'Claude Code 完成啦' };
    case 'StopFailure': return { state: 'error', task: 'Claude Code 出错了' };
    case 'SessionEnd': return { clear: true };
    default: return null;
  }
}

async function alive(base) {
  try {
    return (await fetch(`${base}${PREFIX}/state`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

function candidatePorts() {
  if (process.platform === 'win32') {
    const csv = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const pids = new Set([...csv.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => m[1]));
    if (!pids.size) return [];
    const netstat = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    return [...netstat.matchAll(/127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/g)].filter((m) => pids.has(m[2])).map((m) => m[1]);
  }
  const lsof = execFileSync('lsof', ['-nP', '-iTCP@127.0.0.1', '-sTCP:LISTEN'], { encoding: 'utf8' });
  return lsof.split('\n').filter((line) => /deepseek/i.test(line)).map((line) => line.match(/127\.0\.0\.1:(\d+)/)?.[1]).filter(Boolean);
}

async function resolveBase() {
  if (process.env.DSH_PET_URL) return process.env.DSH_PET_URL.replace(/\/$/, '');
  try {
    const cached = readFileSync(CACHE, 'utf8').trim();
    if (cached && (await alive(cached))) return cached;
  } catch {}
  for (const port of candidatePorts()) {
    const base = `http://127.0.0.1:${port}`;
    if (await alive(base)) {
      writeFileSync(CACHE, base);
      return base;
    }
  }
  return null;
}

async function main() {
  const action = mapEvent(JSON.parse(readFileSync(0, 'utf8') || '{}'));
  if (!action) return;
  const base = await resolveBase();
  if (!base) return;
  const url = `${base}${PREFIX}/work-status`;
  if (action.clear) {
    await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(1500) });
    return;
  }
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(action),
    signal: AbortSignal.timeout(1500),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
