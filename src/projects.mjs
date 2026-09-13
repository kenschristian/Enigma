/** Project descriptors for a configuration already checked by validateConfig. */
export function configuredProjects(config) {
  const projects = config.projects === undefined
    ? [{ key: 'default', repoPath: config.repoPath }]
    : config.projects;
  if (!Array.isArray(projects) || !projects.length) throw new Error('Configuration: no projects configured.');
  // Keep the shared root: adding projects must not move existing conversation worktrees.
  return projects.map(({ key, repoPath }) => ({ key, repoPath, worktreesRoot: config.worktreesRoot }));
}

/** Never fall back to the legacy repository for an unknown or ambiguous channel. */
export function resolveProject(config, channel) {
  if (typeof channel !== 'string' || !Array.isArray(config.allowedChannelIds) || !config.allowedChannelIds.includes(channel)) {
    throw new Error('Project routing: channel is not allowed.');
  }
  if (config.projects === undefined) return configuredProjects(config)[0];
  if (!Array.isArray(config.projects)) throw new Error('Project routing: invalid project configuration.');
  const matches = config.projects.filter(project => Array.isArray(project?.channelIds) && project.channelIds.includes(channel));
  if (matches.length !== 1 || matches[0].channelIds.filter(id => id === channel).length !== 1) {
    throw new Error('Project routing: channel must map to exactly one project.');
  }
  const { key, repoPath } = matches[0];
  return { key, repoPath, worktreesRoot: config.worktreesRoot };
}
