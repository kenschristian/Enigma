import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, defaultConfigPath, MODEL, redact } from './config.mjs';
import { CodexClient } from './codex.mjs';
import { TaskStore } from './store.mjs';
import { WorktreeManager } from './worktrees.mjs';
import { SlackConnection } from './slack.mjs';
import { AgentService } from './service.mjs';
import { configuredProjects, resolveProject } from './projects.mjs';

export async function doctor(config, { log = console.log, Client = CodexClient } = {}) {
  const client = new Client({ command: config?.codexCommand || 'codex', cwd: config?.repoPath || process.cwd() });
  try {
    await client.start();
    const account = await client.account();
    if (!account.account || !['chatgpt', 'chatgptAuthTokens'].includes(account.account.type)) throw new Error('Sign into the installed Codex CLI with your existing ChatGPT account. API-key billing is not used.');
    log('PASS: Existing ChatGPT sign-in.');
    const models = await client.models();
    const model = models.find(m => m.model === MODEL || m.id === MODEL);
    if (!model) throw new Error('GPT-6 Astra is unavailable to this Codex account. No model was substituted.');
    const efforts = model.supportedReasoningEfforts.map(e => typeof e === 'string' ? e : e.reasoningEffort);
    if (!efforts.includes('ultra') || !efforts.includes('high')) throw new Error('This Codex runtime does not expose both Astra Ultra and High. No setting was substituted.');
    log('PASS: GPT-6 Astra supports Ultra for Atlas and High for specialists.');
    if (config) {
      for (const project of configuredProjects(config)) {
        await new WorktreeManager(project).inspect();
        log(`PASS: ${project.key} repository has a committed starting point.`);
      }
      for (const bot of config.bots) {
        const connection = new SlackConnection({ bot, teamId: config.allowedTeamId, allowedUserIds: config.allowedUserIds });
        try { await connection.start(); } finally { connection.stop(); }
        log(`PASS: ${bot.key} belongs to the configured Slack workspace.`);
      }
    } else log('PENDING: Run Setup.ps1 to connect Slack and save the local configuration.');
  } finally { await client.close(); }
}

export async function start(config) {
  await mkdir(config.stateDir, { recursive: true });
  const hash = createHash('sha256').update(path.resolve(config.stateDir).toLowerCase()).digest('hex').slice(0, 20);
  const lock = net.createServer(socket => socket.destroy());
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\enigma-agents-${hash}` : { port: 30000 + parseInt(hash.slice(0, 6), 16) % 30000, host: '127.0.0.1' };
  await new Promise((resolve, reject) => { lock.once('error', () => reject(new Error('Another agent runner is active, or its local lock is unavailable.'))); lock.listen(address, resolve); });
  const log = text => console.log(`${new Date().toISOString()} ${redact(text)}`);
  let store, service;
  const connections = new Map();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const connection of connections.values()) connection.stop();
    await service?.stop();
    store?.close(); lock.close();
    log('Agent runner stopped. Work is saved.');
  };
  try {
    store = new TaskStore(path.join(config.stateDir, 'tasks.db'));
    const managers = new Map(configuredProjects(config).map(project => [project.key, new WorktreeManager(project)]));
    service = new AgentService({ config, store, connections,
      worktreesFor: task => managers.get(resolveProject(config, task.channel).key),
      clientFactory: (_task, worktree) => new CodexClient({ command: config.codexCommand, cwd: worktree.path,
        workspace: { path: worktree.path, gitCommonDir: worktree.gitCommonDir } }), log });
    await doctor(config, { log });
    for (const bot of config.bots) {
      const connection = new SlackConnection({ bot, teamId: config.allowedTeamId, allowedUserIds: config.allowedUserIds, onEnvelope: (payload, source) => service.receive(payload, source) });
      connection.on('warning', log);
      connections.set(bot.key, connection);
      await connection.start();
    }
    service.start();
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    log(`Ready: ${config.bots.length} Slack bot(s); ${config.maxConcurrent} task(s) at a time.`);
    return { service, shutdown };
  } catch (error) { await shutdown(); throw error; }
}

export async function main(args = process.argv.slice(2)) {
  const configIndex = args.indexOf('--config');
  const configFile = configIndex >= 0 ? args[configIndex + 1] : defaultConfigPath();
  if (configIndex >= 0 && !configFile) throw new Error('Supply the configuration file after --config.');
  if (args.includes('doctor')) {
    const config = existsSync(configFile) ? loadConfig(configFile) : configIndex < 0 ? undefined : loadConfig(configFile);
    await doctor(config); return;
  }
  await start(loadConfig(configFile));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}
