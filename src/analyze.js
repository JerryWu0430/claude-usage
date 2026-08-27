import { loadConfig } from './config.js';
import { collectInventory } from './inventory.js';
import { BUILTIN_MCP, collectUsage, isBuiltinCommand } from './transcripts.js';

export const DAY = 86400000;

export const DEFAULTS = {
  graceDays: 14, // freshly installed — no verdict yet
  warmDays: 30, // used this recently = keep
  staleDays: 90, // beyond this = drop
  heavyCount: 20, // proven staple, judged more leniently
};

/** Skills and commands cost context in every session; their descriptions sit in the system prompt. */
function contextCost(item) {
  const text = `${item.name} ${item.description || ''}`;
  return Math.ceil(text.length / 4);
}

/**
 * Skills recorded by Claude Code itself in ~/.claude.json. Authoritative for
 * lifetime counts because it survives transcript deletion, but it has no
 * first-use, project or trend data — those still come from transcripts.
 */
function skillLedger() {
  const raw = loadConfig().skillUsage || {};
  const out = new Map();
  for (const [name, stats] of Object.entries(raw)) {
    if (!stats) continue;
    out.set(name, { count: stats.usageCount || 0, lastUsed: stats.lastUsedAt || null });
  }
  return out;
}

export function verdictFor(item, now, opts, windowDays) {
  const { graceDays, warmDays, staleDays, heavyCount } = opts;
  const idle = item.lastUsed === null ? null : Math.floor((now - item.lastUsed) / DAY);
  const age = item.installedAt === null ? null : Math.floor((now - item.installedAt) / DAY);

  if (item.count === 0) {
    if (age !== null && age < graceDays) return ['new', `installed ${age}d ago, not used yet`];
    if (age !== null) return ['drop', `never used in ${age}d since install`];
    // MCP servers carry no install date; fall back to how long we have been watching.
    return ['drop', windowDays ? `never used in ${windowDays}d of history` : 'never used'];
  }
  if (idle === null) return ['keep', `used ${item.count}x`];
  if (idle <= warmDays) return ['keep', `${item.count}x, last ${idle}d ago`];
  if (item.count >= heavyCount && idle <= staleDays) return ['keep', `${item.count}x staple, cooling (${idle}d)`];
  if (idle <= staleDays) return ['review', `only ${item.count}x, idle ${idle}d`];
  return ['drop', `idle ${idle}d, ${item.count}x lifetime`];
}

/** Trailing weekly totals, oldest first — the input to the sparklines. */
export function weeklyTrend(days, now, weeks = 12) {
  const buckets = new Array(weeks).fill(0);
  for (const [day, n] of Object.entries(days || {})) {
    const ts = Date.parse(`${day}T12:00:00Z`);
    if (!ts) continue;
    // Clamp: `ts` is midday, so a run before 12:00 UTC makes today's delta
    // negative and would push the current week past the end of the array.
    const index = weeks - 1 - Math.floor(Math.max(0, now - ts) / (7 * DAY));
    if (index >= 0 && index < weeks) buckets[index] += n;
  }
  return buckets;
}

export async function analyze(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const now = opts.now || Date.now();

  const inventory = collectInventory();
  const { totals, fileCount } = await collectUsage(options);
  const ledger = skillLedger();

  const items = new Map();
  for (const [key, entry] of inventory) {
    items.set(key, {
      ...entry,
      count: 0,
      lastUsed: null,
      firstUsed: null,
      days: {},
      projects: [],
      installed: true,
    });
  }

  // Where each observed MCP server came from: claude.ai connector, plugin, or local config.
  const mcpOrigins = new Map();
  for (const key of totals.keys()) {
    if (!key.startsWith('mcporigin|')) continue;
    const [name, origin] = key.slice('mcporigin|'.length).split('::');
    mcpOrigins.set(name, origin);
  }

  // Fold transcript usage in, inventing entries for things used but no longer installed.
  for (const [key, usage] of totals) {
    const [kind, name] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    if (kind === 'mcptool' || kind === 'tool' || kind === 'mcporigin') continue;

    // A slash command is invoked through the Skill tool, so the same thing shows
    // up under both kinds. Attach to whichever one is actually installed rather
    // than listing it twice.
    let item = items.get(`${kind}:${name}`);
    if (!item && kind === 'skill') item = items.get(`command:${name}`);
    if (!item && kind === 'command') item = items.get(`skill:${name}`);
    if (!item) {
      item = orphan(kind, name, mcpOrigins.get(name));
      if (!item) continue;
      items.set(`${kind}:${name}`, item);
    }
    // Those two channels overlap for the same invocation, so take the larger
    // rather than summing and inflating the count.
    item.count = Math.max(item.count, usage.count);
    if (usage.first && (!item.firstUsed || usage.first < item.firstUsed)) item.firstUsed = usage.first;
    item.lastUsed = Math.max(item.lastUsed || 0, usage.last || 0) || null;
    for (const [day, n] of Object.entries(usage.days)) item.days[day] = (item.days[day] || 0) + n;
    item.projects = [...new Set([...item.projects, ...[...usage.projects].map(prettyProject)])];
  }

  // Claude Code's own skill counter outranks transcripts where they disagree.
  for (const [name, stats] of ledger) {
    const item = items.get(`skill:${name}`) || items.get(`command:${name}`);
    if (!item) continue;
    item.count = Math.max(item.count, stats.count);
    item.lastUsed = Math.max(item.lastUsed || 0, stats.lastUsed || 0) || null;
    item.ledger = true;
  }

  rollUpPlugins(items);

  // How far back the transcripts reach — the window in which we could have seen usage.
  let earliest = null;
  for (const usage of totals.values()) {
    if (usage.first && (!earliest || usage.first < earliest)) earliest = usage.first;
  }
  const windowDays = earliest ? Math.floor((now - earliest) / DAY) : null;

  for (const item of items.values()) {
    const [verdict, reason] = verdictFor(item, now, opts, windowDays);
    item.verdict = verdict;
    item.reason = reason;
    item.idleDays = item.lastUsed === null ? null : Math.floor((now - item.lastUsed) / DAY);
    item.ageDays = item.installedAt === null ? null : Math.floor((now - item.installedAt) / DAY);
    item.trend = weeklyTrend(item.days, now);
    if (item.kind === 'skill' || item.kind === 'command') item.contextCost = contextCost(item);
    else if (item.kind !== 'plugin') item.contextCost = 0;
  }

  return { items: [...items.values()], now, fileCount, opts, windowDays };
}

/** Usage with no matching install: a removed local item, or a remote claude.ai connector. */
function orphan(kind, name, mcpOrigin) {
  if (kind === 'command') {
    if (isBuiltinCommand(name)) {
      return base(kind, name, { scope: 'builtin', removable: false, builtin: true });
    }
    return base(kind, name, { scope: 'unmanaged', removable: false, missing: true });
  }
  if (kind === 'mcp') {
    if (mcpOrigin === 'connector') {
      return base(kind, name, {
        scope: 'connector',
        removable: false,
        note: 'claude.ai connector — manage at claude.ai/settings/connectors',
      });
    }
    if (BUILTIN_MCP.has(name)) return base(kind, name, { scope: 'builtin', removable: false, builtin: true });
    // Used, but absent from the current config: removed, or scoped to a project
    // Claude Code no longer tracks.
    return base(kind, name, { scope: 'unlisted', removable: false, missing: true });
  }
  if (kind === 'agent') {
    return base(kind, name, { scope: 'builtin', removable: false, builtin: true });
  }
  if (kind === 'skill') {
    return base(kind, name, { scope: 'unmanaged', removable: false, missing: true });
  }
  return null;
}

function base(kind, name, extra) {
  return {
    kind,
    name,
    display: name,
    installedAt: null,
    count: 0,
    lastUsed: null,
    firstUsed: null,
    days: {},
    projects: [],
    installed: false,
    ...extra,
  };
}

/**
 * A plugin is never invoked directly — its usage is whatever its skills,
 * commands, agents and MCP servers did. Without this every plugin reads "never used".
 */
function rollUpPlugins(items) {
  const byOwner = new Map();
  for (const item of items.values()) {
    if (!item.owner) continue;
    if (!byOwner.has(item.owner)) byOwner.set(item.owner, []);
    byOwner.get(item.owner).push(item);
  }
  for (const item of items.values()) {
    if (item.kind !== 'plugin') continue;
    const owned = byOwner.get(item.display) || [];
    item.owned = owned.length;
    item.count = owned.reduce((sum, child) => sum + child.count, 0);
    item.lastUsed = owned.reduce((max, child) => Math.max(max, child.lastUsed || 0), 0) || null;
    const days = {};
    for (const child of owned) {
      for (const [day, n] of Object.entries(child.days || {})) days[day] = (days[day] || 0) + n;
    }
    item.days = days;
    item.projects = [...new Set(owned.flatMap((child) => child.projects))];
    // Every skill a plugin ships is described in the system prompt of every
    // session, so a broad unused plugin is a standing context tax.
    item.contextCost = owned
      .filter((child) => child.kind === 'skill' || child.kind === 'command')
      .reduce((sum, child) => sum + contextCost(child), 0);
  }
}

function prettyProject(dirName) {
  return dirName.replace(/^-/, '').split('-').pop() || dirName;
}

/** What to actually uninstall: dead weight you can remove yourself. */
export function suggestions(items) {
  return items
    .filter((item) => item.verdict === 'drop' && item.removable && item.installed)
    .sort((a, b) => (b.contextCost - a.contextCost) || (b.idleDays || 1e9) - (a.idleDays || 1e9));
}
