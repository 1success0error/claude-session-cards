// Claude Code 给自己的子进程设置的变量。工具可能是从 Claude Code 里启动的，这些变量要是传给它打开的
// 新终端，那里的 claude 会以为自己是子会话而不保存对话记录，会话令牌也会被带出去。
// 只清这份名单：用户自己配置的 CLAUDE_CODE_USE_BEDROCK、CLAUDE_CONFIG_DIR 等要保留。
const SESSION_VARIABLES = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

/** 就地删除；Windows 的 process.env 不区分大小写，用 delete 才可靠。 */
export function removeSessionVariables(env = process.env) {
  for (const name of SESSION_VARIABLES) delete env[name];
  return env;
}
