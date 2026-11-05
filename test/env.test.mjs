import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { removeSessionVariables } from '../lib/env.mjs';

test('清掉 Claude Code 的会话变量，保留用户配置', () => {
  const env = removeSessionVariables({
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_PID: '1',
    AI_AGENT: 'x',
    CLAUDE_CONFIG_DIR: 'D:/config',
    CLAUDE_CODE_USE_BEDROCK: '1',
    PATH: 'C:/bin',
  });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: 'D:/config', CLAUDE_CODE_USE_BEDROCK: '1', PATH: 'C:/bin' });
});

test('桌面程序和命令行启动时都要清理', () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  // 主进程要在创建任何子进程之前清理，所以放在顶层
  assert.match(source('../app/main.mjs'), /^removeSessionVariables\(\);$/m);
  assert.match(source('../bin/cli.mjs'), /const env = removeSessionVariables\(\{ \.\.\.process\.env \}\);/);
});
