// Claude Code 状态栏命令：显示模型和套餐限额，并把限额转给本地卡片服务。服务没开也照常显示。
import { readFileSync } from 'node:fs';

const port = Number(process.env.CLAUDE_SESSION_CARDS_PORT) || 47831;

async function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const limits = input.rate_limits ?? {};
  const percent = (window) => (Number.isFinite(window?.used_percentage) ? `${Math.round(window.used_percentage)}%` : null);
  const parts = [
    input.model?.display_name,
    percent(limits.five_hour) && `5h ${percent(limits.five_hour)}`,
    percent(limits.seven_day) && `7天 ${percent(limits.seven_day)}`,
  ].filter(Boolean);
  process.stdout.write(parts.join(' · '));
  if (!limits.five_hour && !limits.seven_day) return;
  await fetch(`http://127.0.0.1:${port}/api/limits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rate_limits: limits }),
    signal: AbortSignal.timeout(800),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
