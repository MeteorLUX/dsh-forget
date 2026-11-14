/**
 * dsh-forget — a DeepSeek Harness host plugin that deletes past conversation
 * history (sessions) through the `/forget` slash command.
 *
 * DSH's session persistence is append-only and exposes no deletion API, so a
 * session is "forgotten" by (1) removing it from workspace accounting, (2)
 * deleting its on-disk session log directory, and (3) deleting its projection
 * cache checkpoint. The current session is always protected.
 *
 * @module dsh-forget
 */
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Plugin identity. */
const name = 'forget';

/** Cordis services this plugin uses. */
const inject = ['commands', 'sessionQuery', 'workspaceRegistry', 'sessionPersistence', 'agents'];

const USAGE = 'Usage: /forget [list] | /forget <session-id> | /forget <title keyword> | /forget --all';

/** Whether a session has a live agent that is actively running a turn. */
function isRunning(ctx, id) {
  const agent = ctx.agents ? ctx.agents.get(id) : undefined;
  return agent !== undefined && agent.status === 'running';
}

/** Resolve the DeepSeek Harness home (`~/.dsh`, or `$DSH_HOME` when set). */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (env && env.trim().length > 0) return resolve(env.trim());
  return join(homedir(), '.dsh');
}

/** Resolve the session-log root, preferring the running backend's real config. */
function sessionsRoot(ctx) {
  const backend = ctx.sessionPersistence;
  const root = backend && backend.config && typeof backend.config.root === 'string'
    ? backend.config.root
    : '';
  if (root) return root;
  return join(dshHome(), 'sessions');
}

/** Projection-cache checkpoint path for one session id. */
function projectionCacheFile(ctx, id) {
  // root is `<dshHome>/sessions`, so its parent is the harness home.
  return join(dirname(sessionsRoot(ctx)), 'storages', 'session_projcache', 'sessions', `${id}.json`);
}

/**
 * Find every session-log directory whose name equals `id` by walking the
 * project directories under the sessions root. Session ids are path-safe
 * (UUID-derived), so the directory name matches the id verbatim.
 */
async function findSessionDirs(ctx, id) {
  const root = sessionsRoot(ctx);
  const found = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === id) {
        found.push(join(projectPath, entry.name));
      }
    }
  }
  return found;
}

/** Fold a title map (session id -> title string) from a batch observation. */
async function titlesFor(ctx, records) {
  const map = new Map();
  if (records.length === 0) return map;
  let results;
  try {
    results = await ctx.sessionQuery.readTitleSnapshots(records.map((r) => r.header.id));
  } catch {
    return map;
  }
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const snapshot = result.value && result.value.title;
    if (snapshot && typeof snapshot.title === 'string') {
      map.set(result.sessionId, snapshot.title);
    }
  }
  return map;
}

/** Permanently remove one session's durable state and files. */
async function deleteSession(ctx, id) {
  // 1. Durable cleanup: drop the session from every workspace account and from
  //    the global archive/pin sets (both are no-op safe for unknown ids).
  const registry = ctx.workspaceRegistry;
  if (registry) {
    for (const workspace of registry.list()) {
      try {
        if (workspace.sessionIds.includes(id)) await workspace.detachSession(id);
      } catch {
        /* keep going; file deletion below is the authoritative removal */
      }
    }
    try { await registry.unarchiveSession(id); } catch { /* no-op safe */ }
    try { await registry.unpinSession(id); } catch { /* no-op safe */ }
  }

  // 2. Delete the session log directory (handles every project directory and
  //    historical generation files under it).
  for (const dir of await findSessionDirs(ctx, id)) {
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Delete the persisted projection cache checkpoint.
  try {
    await rm(projectionCacheFile(ctx, id), { force: true });
  } catch {
    /* cache is derived; a leftover entry is harmless */
  }
}

/** Render a compact session list. */
function renderList(titles, records, currentId, prefix) {
  const lines = [];
  if (prefix) lines.push(prefix, '');
  if (records.length === 0) {
    lines.push('No sessions found.');
    return { kind: 'success', text: lines.join('\n') };
  }
  for (const record of records) {
    const id = record.header.id;
    const title = titles.get(id);
    const cwd = record.header.cwd || '(no cwd)';
    let tag = '';
    if (id === currentId) tag = ' [current]';
    else if (isRunning(ctx, id)) tag = ' [running]';
    const label = title ? `"${title}"` : '(untitled)';
    lines.push(`${id}${tag}  ${label}  @ ${cwd}`);
  }
  lines.push('', USAGE);
  return { kind: 'success', text: lines.join('\n') };
}

async function deleteOne(ctx, record, currentId, titles) {
  const id = record.header.id;
  if (id === currentId) {
    return {
      kind: 'error',
      text: `这是当前正在进行的会话，不能删除。请先新建一个会话（侧边栏「+」/「新建」）切过去，再回到侧边栏点这个旧会话的「...」→「删除」。\n${USAGE}`,
    };
  }
  if (isRunning(ctx, id)) {
    return {
      kind: 'error',
      text: `Session ${id} is still running; wait for it to finish (or stop it) before deleting.\n${USAGE}`,
    };
  }
  try {
    await deleteSession(ctx, id);
    const title = titles && titles.get(id);
    return { kind: 'success', text: `Deleted session ${id}${title ? ` ("${title}")` : ''}.` };
  } catch (error) {
    return { kind: 'error', text: `Failed to delete session ${id}: ${String(error)}` };
  }
}

async function deleteMany(ctx, targets, currentId) {
  const deleted = [];
  const skipped = [];
  for (const record of targets) {
    const id = record.header.id;
    if (id === currentId) { skipped.push(`${id} (current)`); continue; }
    if (isRunning(ctx, id)) { skipped.push(`${id} (running)`); continue; }
    try {
      await deleteSession(ctx, id);
      deleted.push(id);
    } catch (error) {
      deleted.push(`${id} (failed: ${String(error)})`);
    }
  }
  const lines = [`Deleted ${targets.filter((r) => r.header.id !== currentId && !isRunning(ctx, r.header.id)).length} session(s).`];
  for (const item of deleted) lines.push(`  - ${item}`);
  if (skipped.length > 0) lines.push(`Skipped: ${skipped.join(', ')}`);
  return { kind: 'success', text: lines.join('\n') };
}

/** Execute one parsed /forget command. */
async function execute(ctx, invocation) {
  const currentId = invocation.agent.id;
  const input = invocation.rawInput.trim();

  let records;
  try {
    records = await ctx.sessionQuery.listSessions();
  } catch (error) {
    return { kind: 'error', text: `Failed to list sessions: ${String(error)}` };
  }

  const keyword = input.toLowerCase();
  if (input === '' || keyword === 'list') {
    return renderList(await titlesFor(ctx, records), records, currentId);
  }

  if (input === '--all' || keyword === 'all') {
    const targets = records.filter((r) => r.header.id !== currentId);
    if (targets.length === 0) {
      return { kind: 'success', text: 'No other sessions to delete. The current session cannot be deleted while running.' };
    }
    return deleteMany(ctx, targets, currentId);
  }

  // Exact session-id match wins.
  const byId = records.find((r) => r.header.id === input);
  if (byId) return deleteOne(ctx, byId, currentId, await titlesFor(ctx, [byId]));

  // Otherwise treat the input as a title keyword.
  const titles = await titlesFor(ctx, records);
  const matches = records.filter((r) => {
    const title = titles.get(r.header.id);
    return title ? title.toLowerCase().includes(keyword) : false;
  });
  if (matches.length === 0) {
    return { kind: 'error', text: `No session matches "${input}". Run /forget to list sessions.\n${USAGE}` };
  }
  if (matches.length > 1) {
    return renderList(titles, matches, currentId, `Multiple sessions match "${input}". Delete one by exact session id:`);
  }
  return deleteOne(ctx, matches[0], currentId, titles);
}

function apply(ctx) {
  ctx.commands.register({
    name: 'forget',
    description: 'Delete past conversation history (sessions) from DeepSeek Harness',
    input: { hint: '[list] | <session-id> | <title keyword> | --all' },
    handler: (invocation) => execute(ctx, invocation),
  });
}

export { apply, inject, name };
