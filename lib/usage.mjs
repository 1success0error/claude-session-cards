// 从 Claude Code 的会话记录统计今日和本周的 Token 用量。只取用量数字，不读对话内容。
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const fileCache = new Map(); // 路径 -> { mtimeMs, size, entries: Map<回复标识, 用量> }

export const startOfDay = (now) => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** 本周一 0 点（本地时间）。 */
export const startOfWeek = (now) => {
  const day = new Date(startOfDay(now));
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
};

async function listFiles(dir, out = []) {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await listFiles(path, out); // 子代理的记录在子目录里，也算用量
    else if (item.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** 同一条回复会记录多次，输出数还会随流式返回增长，所以每项取最大值。 */
function mergeRecord(entries, record) {
  const usage = record?.message?.usage;
  const id = record?.message?.id;
  if (record?.type !== 'assistant' || !usage || !id) return;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at)) return;
  const key = `${id}:${record.requestId ?? ''}`;
  const previous = entries.get(key);
  entries.set(key, {
    at: previous ? Math.min(previous.at, at) : at,
    input: Math.max(previous?.input ?? 0, usage.input_tokens ?? 0),
    output: Math.max(previous?.output ?? 0, usage.output_tokens ?? 0),
    cacheRead: Math.max(previous?.cacheRead ?? 0, usage.cache_read_input_tokens ?? 0),
    cacheWrite: Math.max(previous?.cacheWrite ?? 0, usage.cache_creation_input_tokens ?? 0),
  });
}

async function readFileEntries(path) {
  const entries = new Map();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue;
    try {
      mergeRecord(entries, JSON.parse(line));
    } catch {}
  }
  return entries;
}

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function addTo(totals, entry) {
  totals.input += entry.input;
  totals.output += entry.output;
  totals.cacheRead += entry.cacheRead;
  totals.cacheWrite += entry.cacheWrite;
  // 读取缓存不计入主数字：它比其他几项大两个数量级，加进去会掩盖实际消耗
  totals.total += entry.input + entry.output + entry.cacheWrite;
}

export async function scanUsage(configDir, now = Date.now()) {
  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const files = await listFiles(join(configDir, 'projects'));
  const seen = new Set();
  const merged = new Map();
  for (const path of files) {
    seen.add(path);
    try {
      const info = await stat(path);
      if (info.mtimeMs < weekStart) continue; // 本周没写过，不可能有本周的记录
      let cached = fileCache.get(path);
      if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
        cached = { mtimeMs: info.mtimeMs, size: info.size, entries: await readFileEntries(path) };
        fileCache.set(path, cached);
      }
      // 恢复会话时旧记录可能被写进新文件，跨文件也要去重
      for (const [key, entry] of cached.entries) {
        const previous = merged.get(key);
        if (!previous || entry.output > previous.output) merged.set(key, entry);
      }
    } catch {
      // 单个文件读不了（被占用或已被清理）不影响其他文件
    }
  }
  for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);

  const today = emptyTotals();
  const week = emptyTotals();
  for (const entry of merged.values()) {
    if (entry.at >= weekStart) addTo(week, entry);
    if (entry.at >= dayStart) addTo(today, entry);
  }
  return { today, week, weekStart, updatedAt: now };
}

/** 整理状态栏传来的限额数据。窗口可能单独缺失，缺失的保留原值。 */
export function mergeLimits(previous, rateLimits, now = Date.now()) {
  const next = { ...previous };
  for (const [name, key] of [['five_hour', 'fiveHour'], ['seven_day', 'sevenDay']]) {
    const window = rateLimits?.[name];
    if (Number.isFinite(window?.used_percentage)) {
      next[key] = {
        percent: Math.max(0, Math.min(100, window.used_percentage)),
        resetsAt: Number.isFinite(window.resets_at) ? window.resets_at * 1000 : null,
      };
      next.updatedAt = now;
    }
  }
  return next;
}

/** 已过重置时间的窗口不再显示：那个百分比已经不成立了。 */
export function activeLimits(limits, now = Date.now()) {
  const result = { updatedAt: limits?.updatedAt ?? null };
  for (const key of ['fiveHour', 'sevenDay']) {
    const window = limits?.[key];
    if (window && (!window.resetsAt || window.resetsAt > now)) result[key] = window;
  }
  return result;
}
