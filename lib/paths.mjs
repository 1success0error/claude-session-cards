import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_ID = 'claude-session-cards';

export const port = (env = process.env) => Number(env.CLAUDE_SESSION_CARDS_PORT) || 47831;
export const dataDir = (env = process.env) => env.CLAUDE_SESSION_CARDS_HOME || join(homedir(), `.${APP_ID}`);
export const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
