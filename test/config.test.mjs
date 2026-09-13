import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { validateConfig } from '../src/config.mjs';

const root = path.join(os.tmpdir(), 'enigma-project-config');
const base = () => ({
  version: 1, repoPath: path.join(root, 'enigma'), stateDir: path.join(root, 'private', 'state'),
  worktreesRoot: path.join(root, 'private', 'worktrees'),
  allowedTeamId: 'T123', allowedUserIds: ['U123'], allowedChannelIds: ['CWORK', 'CREVIEW', 'CJARVIS'],
  bots: [{ key: 'atlas', role: 'atlas', botTokenEnv: 'ENIGMA_ATLAS_BOT_TOKEN', appTokenEnv: 'ENIGMA_ATLAS_APP_TOKEN' }],
});
const mapped = () => ({ ...base(), projects: [
  { key: 'enigma', repoPath: base().repoPath, channelIds: ['CWORK', 'CREVIEW'] },
  { key: 'jarvis', repoPath: path.join(root, 'jarvis'), channelIds: ['CJARVIS'] },
] });
const validate = config => validateConfig(config, { env: {}, requireTokens: false });

test('legacy version 1 configuration remains valid without project mappings', () => {
  const config = validate(base());
  assert.equal(config.projects, undefined);
  assert.equal(config.worktreesRoot, base().worktreesRoot);
});

test('project mappings normalize repository paths without changing input or shared worktree root', () => {
  const input = mapped();
  input.projects[1].repoPath = `${root}${path.sep}unused${path.sep}..${path.sep}jarvis`;
  const before = structuredClone(input);
  const config = validate(input);
  assert.equal(config.projects[1].repoPath, path.join(root, 'jarvis'));
  assert.equal(config.worktreesRoot, base().worktreesRoot);
  assert.deepEqual(input, before);
});

test('project keys require unique short lowercase names and absolute repositories', () => {
  for (const project of [null, [], {}, { key: 'Jarvis' }, { key: 'a'.repeat(32) }, { key: 'enigma' }, { repoPath: 'relative' }]) {
    const config = mapped();
    config.projects[1] = project === null || Array.isArray(project) ? project : { ...config.projects[1], ...project };
    if (project && !Array.isArray(project) && !Object.keys(project).length) config.projects[1] = {};
    assert.throws(() => validate(config), /Configuration:/);
  }
  for (const projects of [[], null, {}, 'jarvis']) assert.throws(() => validate({ ...base(), projects }), /projects must be/);
});

test('every allowed channel maps exactly once and no outside channel is accepted', () => {
  for (const channelIds of [[], ['*'], ['CUNKNOWN'], ['CWORK'], ['CJARVIS', 'CJARVIS'], ['CJARVIS', 'CREVIEW']]) {
    const config = mapped();
    config.projects[1].channelIds = channelIds;
    assert.throws(() => validate(config), /Configuration:/);
  }
  const missing = mapped();
  missing.projects[0].channelIds = ['CWORK'];
  assert.throws(() => validate(missing), /every allowed channel/);
});

test('private state and worktrees must remain outside each project repository and legacy repository', () => {
  for (const key of ['stateDir', 'worktreesRoot']) {
    for (const project of [base().repoPath, path.join(root, 'jarvis')]) {
      for (const target of [project, path.join(project, 'private')]) {
        assert.throws(() => validate({ ...mapped(), [key]: target }), /outside the repository/);
      }
    }
  }
});

test('existing LOCALAPPDATA, cloud folder and credential guards apply with projects', () => {
  assert.throws(() => validateConfig(mapped(), { env: { LOCALAPPDATA: path.join(root, 'other') }, requireTokens: false }), /inside LOCALAPPDATA/);
  assert.throws(() => validateConfig(mapped(), { env: { OneDrive: path.join(root, 'private') }, requireTokens: false }), /outside cloud-synced/);
  assert.throws(() => validate({ ...mapped(), stateDir: path.join(root, 'OneDrive', 'state') }), /outside OneDrive/);
  assert.throws(() => validateConfig(mapped(), { env: {} }), /credentials are missing/);
});
