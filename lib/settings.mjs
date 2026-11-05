// 把 hook 合并进 Claude Code 的 settings.json / 从中移除。只碰带本工具脚本名的条目。
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCES = join(HERE, '..', 'hooks');

export const CARD_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'TaskCreated', 'TaskCompleted'];
export const PET_EVENTS = ['SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'StopFailure'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

export const CARD_SCRIPT = 'claude-session-cards.mjs';
export const PET_SCRIPT = 'claude-session-cards-dsh-pet.mjs';
const SCRIPTS = [CARD_SCRIPT, PET_SCRIPT];

const isOurs = (hook) => typeof hook?.command === 'string' && SCRIPTS.some((name) => hook.command.includes(name));

export function addHooks(settings, script, events, command) {
  settings.hooks ??= {};
  if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('settings.json 里的 hooks 不是对象，已停止修改');
  for (const event of events) {
    const groups = (settings.hooks[event] ??= []);
    if (!Array.isArray(groups)) throw new Error(`settings.json 里的 hooks.${event} 不是数组，已停止修改`);
    if (groups.some((g) => g?.hooks?.some?.((h) => h?.command?.includes?.(script)))) continue;
    const entry = { hooks: [{ type: 'command', command, async: true, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) entry.matcher = '*';
    groups.push(entry);
  }
  return settings;
}

export function removeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return settings;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => !isOurs(h));
      if (hooks.length) kept.push(hooks.length === group.hooks.length ? group : { ...group, hooks });
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new Error(`${file} 不是有效的 JSON 对象，为避免破坏它，已停止修改`);
}

function writeSettings(file, settings) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.bak-claude-session-cards`);
  const tmp = `${file}.tmp-claude-session-cards`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}

function installScript(dir, name) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  copyFileSync(join(HOOK_SOURCES, name), target);
  chmodSync(target, 0o644);
  return target;
}

const commandFor = (path) => `node "${path.replaceAll('\\', '/')}"`;

/** 脚本复制到 Claude 配置目录，路径不随 npm 全局目录（如 nvm 切换）变化。 */
export function install(configDir, { dshPet = false } = {}) {
  const file = join(configDir, 'settings.json');
  const settings = removeHooks(readSettings(file));
  const hooksDir = join(configDir, 'hooks');
  addHooks(settings, CARD_SCRIPT, CARD_EVENTS, commandFor(installScript(hooksDir, CARD_SCRIPT)));
  if (dshPet) addHooks(settings, PET_SCRIPT, PET_EVENTS, commandFor(installScript(hooksDir, PET_SCRIPT)));
  else rmSync(join(hooksDir, PET_SCRIPT), { force: true });
  writeSettings(file, settings);
  return file;
}

export function uninstall(configDir) {
  const file = join(configDir, 'settings.json');
  if (existsSync(file)) writeSettings(file, removeHooks(readSettings(file)));
  for (const name of SCRIPTS) rmSync(join(configDir, 'hooks', name), { force: true });
  return file;
}

export function isInstalled(configDir) {
  try {
    return Boolean(readSettings(join(configDir, 'settings.json')).hooks?.Stop?.some((g) => g?.hooks?.some(isOurs)));
  } catch {
    return false;
  }
}
