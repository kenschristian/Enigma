import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { configuredProjects, resolveProject } from '../src/projects.mjs';

const root = path.join(os.tmpdir(), 'enigma-project-routing');
const legacy = { repoPath: path.join(root, 'enigma'), worktreesRoot: path.join(root, 'worktrees'), allowedChannelIds: ['CENIGMA', 'CJARVIS'] };
const config = { ...legacy, projects: [
  { key: 'enigma', repoPath: legacy.repoPath, channelIds: ['CENIGMA'] },
  { key: 'jarvis', repoPath: path.join(root, 'jarvis'), channelIds: ['CJARVIS'] },
] };

test('legacy allowlisted channels retain the original repository and worktree root', () => {
  const expected = { key: 'default', repoPath: legacy.repoPath, worktreesRoot: legacy.worktreesRoot };
  assert.deepEqual(configuredProjects(legacy), [expected]);
  assert.deepEqual(resolveProject(legacy, 'CENIGMA'), expected);
  assert.throws(() => resolveProject(legacy, 'CUNKNOWN'), /not allowed/);
});

test('different project channels resolve their repositories while preserving shared worktree root', () => {
  assert.deepEqual(resolveProject(config, 'CENIGMA'), { key: 'enigma', repoPath: legacy.repoPath, worktreesRoot: legacy.worktreesRoot });
  assert.deepEqual(resolveProject(config, 'CJARVIS'), { key: 'jarvis', repoPath: path.join(root, 'jarvis'), worktreesRoot: legacy.worktreesRoot });
  assert.deepEqual(configuredProjects(config), config.projects.map(({ key, repoPath }) => ({ key, repoPath, worktreesRoot: legacy.worktreesRoot })));
});

test('unknown, missing and duplicate channel mappings fail closed even for unvalidated callers', () => {
  for (const channel of ['CUNKNOWN', undefined, null, 1]) assert.throws(() => resolveProject(config, channel), /not allowed/);
  assert.throws(() => resolveProject({ ...legacy, allowedChannelIds: 'CENIGMA' }, 'CENIGMA'), /not allowed/);
  assert.throws(() => resolveProject({ ...config, projects: [config.projects[0]] }, 'CJARVIS'), /exactly one project/);
  assert.throws(() => resolveProject({ ...config, projects: [...config.projects, config.projects[1]] }, 'CJARVIS'), /exactly one project/);
  assert.throws(() => resolveProject({ ...config, projects: [{ ...config.projects[1], channelIds: ['CJARVIS', 'CJARVIS'] }] }, 'CJARVIS'), /exactly one project/);
  assert.throws(() => resolveProject({ ...config, projects: null }, 'CJARVIS'), /invalid project/);
});

test('doctor descriptors do not expose channel arrays or allow mutation of project config', () => {
  const descriptors = configuredProjects(config);
  assert.equal(descriptors[0].channelIds, undefined);
  descriptors[0].repoPath = path.join(root, 'other');
  assert.equal(config.projects[0].repoPath, legacy.repoPath);
});
