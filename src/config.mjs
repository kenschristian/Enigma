import { readFileSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const MODEL = 'gpt-6-astra';
export const ROLES = Object.freeze({ atlas: 'Atlas', frontend: 'Nova', backend: 'Forge', api: 'Bridge' });
export const defaultConfigPath = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'EnigmaAgents', 'config.json');

export function validateConfig(value, { env = process.env, requireTokens = true } = {}) {
  const fail = message => { throw new Error(`Configuration: ${message}`); };
  if (!value || value.version !== 1) fail('version must be 1. Run Setup.ps1.');
  const c = structuredClone(value);
  for (const key of ['repoPath', 'stateDir', 'worktreesRoot']) {
    if (typeof c[key] !== 'string' || !path.isAbsolute(c[key])) fail(`${key} must be an absolute folder path.`);
    c[key] = path.resolve(c[key]);
  }
  for (const key of ['stateDir', 'worktreesRoot']) {
    const relative = path.relative(c.repoPath, c[key]);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail(`${key} must be outside the repository.`);
    if (c[key].split(/[\\/]/).some(p => /^onedrive(?:\s*-.*)?$/i.test(p))) fail(`${key} must be outside OneDrive.`);
    if (env.LOCALAPPDATA) {
      const local = path.relative(path.resolve(env.LOCALAPPDATA), c[key]);
      if (!local || local === '..' || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) fail(`${key} must be inside LOCALAPPDATA.`);
    }
    for (const cloud of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean)) {
      const relativeCloud = path.relative(path.resolve(cloud), c[key]);
      if (!relativeCloud || (!relativeCloud.startsWith(`..${path.sep}`) && relativeCloud !== '..' && !path.isAbsolute(relativeCloud))) fail(`${key} must be outside cloud-synced folders.`);
    }
    for (let part = c[key]; part !== path.dirname(part); part = path.dirname(part)) {
      if (existsSync(part) && lstatSync(part).isSymbolicLink()) fail(`${key} must not use links or junctions.`);
    }
  }
  if (!/^T[A-Z0-9]+$/.test(c.allowedTeamId)) fail('enter the Slack workspace ID (starts with T).');
  for (const [key, pattern] of [['allowedUserIds', /^[UW][A-Z0-9]+$/], ['allowedChannelIds', /^[CG][A-Z0-9]+$/]]) {
    if (!Array.isArray(c[key]) || !c[key].length || c[key].some(v => typeof v !== 'string' || !pattern.test(v))) fail(`${key} must contain explicit Slack IDs.`);
  }
  c.maxConcurrent ??= 1;
  c.taskTimeoutMinutes ??= 45;
  if (!Number.isInteger(c.maxConcurrent) || c.maxConcurrent < 1 || c.maxConcurrent > 3) fail('maxConcurrent must be 1 to 3.');
  if (!Number.isInteger(c.taskTimeoutMinutes) || c.taskTimeoutMinutes < 1 || c.taskTimeoutMinutes > 180) fail('taskTimeoutMinutes must be 1 to 180.');
  c.codexCommand ||= 'codex';
  if (typeof c.codexCommand !== 'string' || /[\r\n]/.test(c.codexCommand)) fail('invalid Codex executable.');
  if (!Array.isArray(c.bots) || c.bots.length < 1 || c.bots.length > 4) fail('configure between one and four bots.');
  const keys = new Set(), names = new Set();
  for (const bot of c.bots) {
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(bot.key) || keys.has(bot.key)) fail('bot keys must be unique short names.');
    keys.add(bot.key);
    if (!Object.hasOwn(ROLES, bot.role)) fail('bot role must be atlas, frontend, backend or api.');
    for (const [key, prefix] of [['botTokenEnv', 'xoxb-'], ['appTokenEnv', 'xapp-']]) {
      if (!/^ENIGMA_[A-Z0-9_]+$/.test(bot[key]) || names.has(bot[key])) fail('each token requires a unique ENIGMA_ environment name.');
      names.add(bot[key]);
      if (requireTokens && !env[bot[key]]?.startsWith(prefix)) fail(`${bot.key} credentials are missing. Use Start-Agents.ps1 after Setup.ps1.`);
    }
  }
  return c;
}

export function loadConfig(file = defaultConfigPath(), options) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Configuration is missing or unreadable. Run scripts/Setup.ps1 first.'); }
  return validateConfig(value, options);
}

export function redact(text, env = process.env) {
  let result = String(text ?? '');
  for (const [key, value] of Object.entries(env)) {
    if (/^ENIGMA_.*TOKEN$/.test(key) && value?.length > 5) result = result.split(value).join('[redacted]');
  }
  return result.replace(/\b(?:xox[baprs]-|xapp-)[\w-]+/g, '[redacted]').replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[redacted]');
}
