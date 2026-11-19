// 根据前台终端窗口的标题（就是选中标签的标题）判断用户正在看哪个会话。

/**
 * sessions: [{ id, chain, titles }]；tab: { pid, title }，pid 是终端进程。
 * 标题互相包含时取最长的那个；仍分不出（同名会话、没有标题的会话）就返回 null，宁可不确认也不确认错。
 */
export function sessionInTab(sessions, tab) {
  if (!tab?.title) return null;
  let best = null;
  let bestLength = 0;
  let tie = false;
  for (const s of sessions) {
    const terminal = s.chain?.find((p) => /^WindowsTerminal/i.test(p.name));
    if (terminal && terminal.pid !== tab.pid) continue; // 在别的终端进程里
    const length = Math.max(0, ...s.titles.filter((t) => t && tab.title.includes(t)).map((t) => t.length));
    if (!length) continue;
    if (length > bestLength) {
      best = s.id;
      bestLength = length;
      tie = false;
    } else if (length === bestLength && s.id !== best) {
      tie = true;
    }
  }
  return tie ? null : best;
}
