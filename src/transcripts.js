import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { CACHE_FILE, PROJECTS_DIR, listDir, readJson } from './config.js';

const CACHE_VERSION = 3;

/** Slash commands the CLI ships with — usable data, but nothing to uninstall. */
const BUILTIN_COMMANDS = new Set([
  'add-dir', 'agents', 'artifacts', 'bashes', 'branch', 'bug', 'clear', 'compact', 'config',
  'context', 'cost', 'doctor', 'effort', 'exit', 'export', 'fast', 'feedback', 'help', 'hooks',
  'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp', 'memory', 'migrate-installer',
  'model', 'output-style', 'permissions', 'plan', 'pr-comments', 'privacy-settings',
  'release-notes', 'resume', 'sandbox', 'schedule', 'skills', 'status', 'statusline',
  'terminal-setup', 'todos', 'upgrade', 'usage', 'vim', 'worktree', 'tasks', 'loop',
]);

/** MCP servers Claude Code ships with — present without a config entry. */
export const BUILTIN_MCP = new Set(['claude-in-chrome']);

export function isBuiltinCommand(name) {
  return BUILTIN_COMMANDS.has(name);
}

/** `mcp__claude_ai_Figma__use_figma` -> { server: 'claude_ai_Figma', tool: 'use_figma' } */
export function parseMcpToolName(name) {
  const rest = name.slice('mcp__'.length);
  const split = rest.indexOf('__');
  if (split === -1) return { server: rest, tool: '' };
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/**
 * Transcript server ids are namespaced by where the server came from. Map them
 * back to the name shown in config so usage lines up with inventory.
 */
export function normalizeMcpServer(server) {
  if (server.startsWith('claude_ai_')) {
    return { name: server.slice('claude_ai_'.length), origin: 'connector' };
  }
  if (server.startsWith('plugin_')) {
    const parts = server.slice('plugin_'.length).split('_');
    return { name: parts[parts.length - 1], origin: 'plugin' };
  }
  return { name: server, origin: 'local' };
}

/** Sessions sit at `projects/<project>/*.jsonl`; subagent runs nest arbitrarily below that. */
function transcriptFiles() {
  const out = [];
  const walk = (dir, project) => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, project);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      out.push({ file: full, project, sig: `${Math.round(stat.mtimeMs)}:${stat.size}` });
    }
  };
  for (const project of listDir(PROJECTS_DIR)) {
    if (!project.isDirectory()) continue;
    walk(path.join(PROJECTS_DIR, project.name), project.name);
  }
  return out;
}

const COMMAND_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/g;

/** Records one invocation into the per-file `{ 'kind|name': stats }` bucket map. */
function record(buckets, kind, name, ts) {
  if (!name) return;
  const key = `${kind}|${name}`;
  let entry = buckets[key];
  if (!entry) entry = buckets[key] = { c: 0, f: ts, l: ts, d: {} };
  entry.c += 1;
  if (ts) {
    if (!entry.f || ts < entry.f) entry.f = ts;
    if (!entry.l || ts > entry.l) entry.l = ts;
    const day = new Date(ts).toISOString().slice(0, 10);
    entry.d[day] = (entry.d[day] || 0) + 1;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

async function scanFile(file) {
  const buckets = {};
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    // Cheap prefilter: the vast majority of transcript lines carry neither marker,
    // and JSON.parse over ~400MB of them dominates runtime otherwise.
    const hasTool = line.includes('"tool_use"');
    const hasCommand = line.includes('<command-name>');
    if (!hasTool && !hasCommand) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(row.timestamp) || null;
    const content = row.message && row.message.content;

    if (hasCommand) {
      const text = textOf(content);
      COMMAND_RE.lastIndex = 0;
      let match;
      while ((match = COMMAND_RE.exec(text))) record(buckets, 'command', match[1], ts);
    }

    if (hasTool && Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || !block.name) continue;
        const input = block.input || {};
        if (block.name === 'Skill') {
          record(buckets, 'skill', input.skill, ts);
        } else if (block.name === 'Agent' || block.name === 'Task') {
          record(buckets, 'agent', input.subagent_type || 'general-purpose', ts);
        } else if (block.name.startsWith('mcp__')) {
          const { server, tool } = parseMcpToolName(block.name);
          const { name, origin } = normalizeMcpServer(server);
          record(buckets, 'mcp', name, ts);
          record(buckets, 'mcporigin', `${name}::${origin}`, ts);
          record(buckets, 'mcptool', `${name}/${tool}`, ts);
        } else {
          record(buckets, 'tool', block.name, ts);
        }
      }
    }
  }
  return buckets;
}

function loadCache() {
  const cache = readJson(CACHE_FILE, null);
  if (!cache || cache.v !== CACHE_VERSION) return { v: CACHE_VERSION, files: {} };
  return cache;
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // A cache we cannot persist is a slow run, not a failed one.
  }
}

/**
 * Aggregate every transcript into `{ 'kind|name': { count, first, last, days, projects } }`.
 * Results are cached per file by mtime+size, so repeat runs only read new sessions.
 */
export async function collectUsage({ noCache = false, onProgress } = {}) {
  const files = transcriptFiles();
  const cache = noCache ? { v: CACHE_VERSION, files: {} } : loadCache();
  const next = { v: CACHE_VERSION, files: {} };

  let scanned = 0;
  for (let i = 0; i < files.length; i++) {
    const { file, project, sig } = files[i];
    const cached = cache.files[file];
    if (cached && cached.sig === sig) {
      next.files[file] = cached;
    } else {
      next.files[file] = { sig, project, items: await scanFile(file) };
      scanned++;
    }
    if (onProgress) onProgress(i + 1, files.length, scanned);
  }
  saveCache(next);

  const totals = new Map();
  for (const entry of Object.values(next.files)) {
    for (const [key, stats] of Object.entries(entry.items)) {
      let agg = totals.get(key);
      if (!agg) {
        agg = { count: 0, first: null, last: null, days: {}, projects: new Set() };
        totals.set(key, agg);
      }
      agg.count += stats.c;
      if (stats.f && (!agg.first || stats.f < agg.first)) agg.first = stats.f;
      if (stats.l && (!agg.last || stats.l > agg.last)) agg.last = stats.l;
      for (const [day, n] of Object.entries(stats.d)) agg.days[day] = (agg.days[day] || 0) + n;
      if (entry.project) agg.projects.add(entry.project);
    }
  }
  return { totals, fileCount: files.length, scanned };
}
