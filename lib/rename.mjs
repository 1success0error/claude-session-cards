// 把卡片上改的标题同步给 Claude Code：用官方的 /rename，不直接写它的记录文件。
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeSessionVariables } from './env.mjs';
import { SESSION_ID_RE } from './history.mjs';

const RENAME_TIMEOUT_MS = 60_000;
const UNKNOWN_CHAIN_WINDOW_MS = 30 * 60 * 1000;

/**
 * 会话是否可能还开着。开着时不能同步：/rename 要启动第二个进程写同一份记录，对话会分叉。
 * 拿不准时算开着，宁可晚点同步。
 */
export function sessionMayBeOpen(session, now = Date.now(), isAlive = processAlive) {
  if (!session) return false;
  const agent = session.chain?.find((p) => /^(claude|node)/i.test(p.name));
  if (agent) return isAlive(agent.pid);
  return now - session.updatedAt < UNKNOWN_CHAIN_WINDOW_MS;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 进程存在，只是没权限（比如以管理员身份运行）
  }
}

/** 运行 /rename，成功返回 true。这个命令不调用模型。 */
export function renameSession({ id, title, cwd, dataDir }) {
  if (!SESSION_ID_RE.test(id) || !cwd) return Promise.resolve(false);
  // 临时进程不能触发 hook：它结束时的 SessionEnd 会把同一会话的卡片删掉
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const settings = join(dataDir, 'rename-settings.json');
  writeFileSync(settings, '{"disableAllHooks":true}');
  const env = removeSessionVariables({ ...process.env, CARDS_RENAME: title, CARDS_SETTINGS: settings });
  const options = { cwd, env, timeout: RENAME_TIMEOUT_MS, windowsHide: true };
  const finish = (resolve) => (err, stdout) => {
    if (err) return resolve(false);
    try {
      const result = JSON.parse(stdout);
      resolve(result.type === 'result' && result.is_error === false);
    } catch {
      resolve(false);
    }
  };
  return new Promise((resolve) => {
    const args = ['-p', '--resume', id, '--output-format', 'json', '--settings', settings];
    const child = process.platform === 'win32'
      // npm 装的 claude 是 .cmd，要经过 PowerShell；标题放环境变量里，不会被当成命令解析
      ? execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `claude ${args.slice(0, -1).join(' ')} $env:CARDS_SETTINGS "/rename $($env:CARDS_RENAME.Replace('\"', '\\\"'))"`], options, finish(resolve))
      : execFile('claude', [...args, `/rename ${title}`], options, finish(resolve));
    child.stdin?.end();
    child.on('error', () => resolve(false));
  });
}
