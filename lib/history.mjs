// 读取 Claude Code 保存的历史会话（<配置目录>/projects/<项目>/<会话ID>.jsonl）。
// 记录格式不是公开约定，所以每个字段都按可能缺失处理；只读文件首尾，不解析全文。
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_BYTES = 256 * 1024;
const PROMPT_MAX = 120;
const CONCURRENCY = 8;

const cache = new Map(); // 路径 -> { mtimeMs, size, entry }

const projectOf = (cwd) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;

function parseLines(text, { dropFirst, dropLast }) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const records = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  return records;
}

function promptOf(record) {
  if (record.type !== 'user' || record.isMeta || record.isSidechain) return null;
  const content = record.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find((c) => c?.type === 'text')?.text : null;
  if (typeof text !== 'string') return null;
  const clean = text.replace(/<\/?pasted_content\b[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.startsWith('<')) return null; // 斜杠命令和系统注入的内容，不是用户写的话
  return Array.from(clean).slice(0, PROMPT_MAX).join('');
}

/** 取最新的标题，手动命名优先。 */
function titleOf(records) {
  let ai = null;
  let custom = null;
  for (const r of records) {
    if (typeof r.customTitle === 'string' && r.customTitle) custom = r.customTitle;
    if (typeof r.aiTitle === 'string' && r.aiTitle) ai = r.aiTitle;
  }
  return custom ?? ai;
}

export async function readEntry(path, id, info) {
  const file = await open(path, 'r');
  try {
    const headLength = Math.min(info.size, EDGE_BYTES);
    const head = Buffer.alloc(headLength);
    await file.read(head, 0, headLength, 0);
    const tailLength = Math.min(info.size, EDGE_BYTES);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, info.size - tailLength);

    const headRecords = parseLines(head.toString('utf8'), { dropFirst: false, dropLast: info.size > EDGE_BYTES });
    const tailRecords = info.size > EDGE_BYTES ? parseLines(tail.toString('utf8'), { dropFirst: true, dropLast: false }) : headRecords;
    const all = info.size > EDGE_BYTES ? [...headRecords, ...tailRecords] : headRecords;

    // 没有任何对话内容的是空壳记录，恢复不了
    if (!all.some((r) => r.type === 'user' || r.type === 'assistant')) return null;

    let prompt = null;
    for (const r of headRecords) {
      prompt = promptOf(r);
      if (prompt) break;
    }
    const cwd = all.find((r) => typeof r.cwd === 'string' && r.cwd)?.cwd ?? null;
    return {
      id,
      title: titleOf(all),
      prompt,
      cwd,
      project: cwd ? projectOf(cwd) : null,
      mtime: info.mtimeMs,
      size: info.size,
    };
  } finally {
    await file.close();
  }
}

async function listFiles(projectsDir) {
  const files = [];
  let dirs;
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return files; // 还没有任何历史
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const names = await readdir(join(projectsDir, dir.name)).catch(() => []);
    for (const name of names) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      if (SESSION_ID_RE.test(id)) files.push({ path: join(projectsDir, dir.name, name), id });
    }
  }
  return files;
}

/** 所有历史会话，按最后修改时间倒序。文件没变就用缓存。 */
export async function scanHistory(configDir) {
  const files = await listFiles(join(configDir, 'projects'));
  const entries = [];
  const seen = new Set();
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const { path, id } = files[next++];
      seen.add(path);
      try {
        const info = await stat(path);
        const hit = cache.get(path);
        if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
          if (hit.entry) entries.push(hit.entry);
          continue;
        }
        const entry = await readEntry(path, id, info);
        cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, entry });
        if (entry) entries.push(entry);
      } catch {
        // 单个文件读不了（被占用或已被清理）不影响其他会话
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  return entries.sort((a, b) => b.mtime - a.mtime);
}
