// 历史会话的对话全文搜索：只收录用户写的话和 Claude 的回复文字，不含工具调用、工具输出和系统注入的内容。
// 正文只放在内存里，按文件缓存；会话文件只会追加，所以文件变长时只读新增的部分。
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listFiles } from './history.mjs';

const CONCURRENCY = 4;
const QUERY_MAX = 200;
const SNIPPETS = 2;
const BEFORE = 30;
const AFTER = 90;

const index = new Map(); // 路径 -> { id, mtimeMs, size, offset, messages: [{ role, text, lower }] }
let building = null;

function messageOf(record) {
  if (record.isSidechain || record.isMeta) return null;
  const role = record.type === 'user' ? 'user' : record.type === 'assistant' ? 'assistant' : null;
  if (!role) return null;
  const content = record.message?.content;
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text) : [];
  const text = parts
    .map((t) => t.replace(/<\/?pasted_content\b[^>]*>/g, ' ').trim())
    // 斜杠命令、系统提醒这类以标签开头的内容不是对话
    .filter((t) => t && !(role === 'user' && t.startsWith('<')))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? { role, text, lower: text.toLowerCase() } : null;
}

/** 从 offset 读到文件末尾最后一个换行，返回解析出的消息和新的 offset。 */
async function readMessages(path, offset, size) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(0x0a, bytesRead - 1);
    if (end < 0) return { messages: [], offset };
    const messages = [];
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      // 工具输出往往很大，先粗筛再解析
      if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
      try {
        const message = messageOf(JSON.parse(line));
        if (message) messages.push(message);
      } catch {}
    }
    return { messages, offset: offset + end + 1 };
  } finally {
    await file.close();
  }
}

async function refresh(path, id) {
  const info = await stat(path);
  const hit = index.get(path);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return;
  const append = hit && info.size >= hit.size;
  const { messages, offset } = await readMessages(path, append ? hit.offset : 0, info.size);
  index.set(path, { id, mtimeMs: info.mtimeMs, size: info.size, offset, messages: append ? hit.messages.concat(messages) : messages });
}

/** 让索引和磁盘一致。并发调用共用同一次更新。 */
export function updateIndex(configDir) {
  building ??= (async () => {
    try {
      const files = await listFiles(join(configDir, 'projects'));
      const seen = new Set(files.map((f) => f.path));
      for (const path of index.keys()) if (!seen.has(path)) index.delete(path);
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const { path, id } = files[next++];
          try {
            await refresh(path, id);
          } catch {
            index.delete(path); // 读不了（被占用或已删除），下次再试
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      building = null;
    }
  })();
  return building;
}

export const termsOf = (query) => [...new Set(String(query ?? '').slice(0, QUERY_MAX).toLowerCase().split(/\s+/).filter(Boolean))];

function snippetOf(message, term) {
  const at = message.lower.indexOf(term);
  const chars = Array.from(message.text);
  // indexOf 是 UTF-16 位置，换算成字符位置，避免切断代理对
  const start = Array.from(message.text.slice(0, at)).length;
  const from = Math.max(0, start - BEFORE);
  const to = Math.min(chars.length, start + Array.from(term).length + AFTER);
  return `${from > 0 ? '…' : ''}${chars.slice(from, to).join('')}${to < chars.length ? '…' : ''}`;
}

/** 每个词都要在同一个会话里出现（可以在不同消息里），不区分大小写。 */
export async function searchHistory(configDir, query) {
  const terms = termsOf(query);
  if (!terms.length) return [];
  await updateIndex(configDir);
  const results = [];
  for (const { id, messages } of index.values()) {
    if (!terms.every((t) => messages.some((m) => m.lower.includes(t)))) continue;
    const hits = messages.filter((m) => terms.some((t) => m.lower.includes(t)));
    // 优先展示同时包含最多关键词的消息
    const ranked = hits.map((m) => ({ m, n: terms.filter((t) => m.lower.includes(t)).length })).sort((a, b) => b.n - a.n);
    const snippets = ranked.slice(0, SNIPPETS).map(({ m }) => ({ role: m.role, text: snippetOf(m, terms.find((t) => m.lower.includes(t))) }));
    results.push({ id, count: hits.length, snippets });
  }
  return results;
}
