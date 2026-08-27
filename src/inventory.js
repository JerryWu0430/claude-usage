import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, createdAt, entryKind, linkTarget, listDir, loadConfig, loadInstalledPlugins } from './config.js';
import { shellQuote } from './format.js';

/**
 * Everything currently installed, keyed `${kind}:${name}`.
 * Usage data is merged onto this in analyze.js — an item can be used but not
 * installed (a since-removed skill) or installed but never used (the point).
 */
export function collectInventory() {
  const items = new Map();
  const add = (item) => items.set(`${item.kind}:${item.name}`, item);

  for (const it of userSkills()) add(it);
  for (const it of userCommands()) add(it);
  for (const it of userAgents()) add(it);

  const plugins = loadInstalledPlugins();
  for (const [id, installs] of Object.entries(plugins)) {
    const install = Array.isArray(installs) ? installs[0] : installs;
    if (!install) continue;
    const short = id.split('@')[0];
    add({
      kind: 'plugin',
      name: id,
      display: short,
      scope: install.scope || 'user',
      installedAt: Date.parse(install.installedAt) || null,
      version: install.version,
      removable: true,
      removeCmd: `claude plugin uninstall ${shellQuote(id)}`,
    });
    for (const it of pluginContents(short, install)) add(it);
  }

  for (const it of mcpServers()) add(it);
  return items;
}

function skillFrom(dir, name, extra) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  return {
    kind: 'skill',
    name,
    display: name,
    description: frontmatterDescription(skillFile),
    installedAt: createdAt(dir),
    ...extra,
  };
}

function userSkills() {
  const root = path.join(CLAUDE_DIR, 'skills');
  const out = [];
  for (const entry of listDir(root)) {
    const dir = path.join(root, entry.name);
    if (entryKind(entry, dir) !== 'dir') continue;
    // Unlinking a symlinked skill disables it without touching the source library.
    const target = linkTarget(dir);
    const skill = skillFrom(dir, entry.name, {
      scope: 'user',
      removable: true,
      linkedFrom: target,
      removeCmd: target ? `rm ${shellQuote(dir)}` : `rm -rf ${shellQuote(dir)}`,
    });
    if (skill) out.push(skill);
  }
  return out;
}

function userCommands() {
  const root = path.join(CLAUDE_DIR, 'commands');
  return commandsIn(root).map((c) => ({
    ...c,
    scope: 'user',
    removable: true,
    removeCmd: `rm ${shellQuote(c.file)}`,
  }));
}

function userAgents() {
  const root = path.join(CLAUDE_DIR, 'agents');
  const out = [];
  for (const entry of listDir(root)) {
    const file = path.join(root, entry.name);
    if (!entry.name.endsWith('.md') || entryKind(entry, file) !== 'file') continue;
    out.push({
      kind: 'agent',
      name: entry.name.replace(/\.md$/, ''),
      display: entry.name.replace(/\.md$/, ''),
      scope: 'user',
      installedAt: createdAt(file),
      removable: true,
      removeCmd: `rm ${shellQuote(file)}`,
    });
  }
  return out;
}

/** Commands are `.md` files; `_name.md` is a shared include, and `.md.tmpl` a template. */
function commandsIn(root, prefix = '') {
  const out = [];
  for (const entry of listDir(root)) {
    const full = path.join(root, entry.name);
    const kind = entryKind(entry, full);
    if (kind === 'dir') {
      out.push(...commandsIn(full, `${prefix}${entry.name}:`));
      continue;
    }
    if (kind !== 'file' || !entry.name.endsWith('.md') || entry.name.startsWith('_')) continue;
    const name = prefix + entry.name.replace(/\.md$/, '');
    out.push({
      kind: 'command',
      name,
      display: name,
      file: full,
      description: frontmatterDescription(full),
      installedAt: createdAt(full),
    });
  }
  return out;
}

/** Skills, commands and agents a plugin contributes, namespaced `plugin:name`. */
function pluginContents(plugin, install) {
  const root = install.installPath;
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const owned = {
    scope: `plugin:${plugin}`,
    installedAt: Date.parse(install.installedAt) || null,
    removable: false,
    removeCmd: null,
    owner: plugin,
  };

  for (const entry of listDir(path.join(root, 'skills'))) {
    const dir = path.join(root, 'skills', entry.name);
    if (entryKind(entry, dir) !== 'dir') continue;
    const skill = skillFrom(dir, `${plugin}:${entry.name}`, owned);
    if (skill) out.push(skill);
  }
  for (const cmd of commandsIn(path.join(root, 'commands'))) {
    out.push({ ...cmd, name: `${plugin}:${cmd.name}`, display: `${plugin}:${cmd.name}`, ...owned });
  }
  for (const entry of listDir(path.join(root, 'agents'))) {
    if (!entry.name.endsWith('.md') || entryKind(entry, path.join(root, 'agents', entry.name)) !== 'file') continue;
    const base = entry.name.replace(/\.md$/, '');
    out.push({ kind: 'agent', name: `${plugin}:${base}`, display: `${plugin}:${base}`, ...owned });
  }
  return out;
}

/**
 * MCP servers from three places: user config, per-project config, and plugin
 * bundles. Remote claude.ai connectors live server-side and only surface via usage.
 */
function mcpServers() {
  const config = loadConfig();
  const out = [];
  const seen = new Set();

  const push = (name, scope, extra) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ kind: 'mcp', name, display: name, scope, ...extra });
  };

  for (const name of Object.keys(config.mcpServers || {})) {
    push(name, 'user', {
      installedAt: null,
      removable: true,
      removeCmd: `claude mcp remove ${shellQuote(name)} -s user`,
    });
  }

  for (const [projectPath, project] of Object.entries(config.projects || {})) {
    for (const name of Object.keys((project && project.mcpServers) || {})) {
      push(name, 'project', {
        installedAt: null,
        removable: true,
        removeCmd: `claude mcp remove ${shellQuote(name)} -s local`,
        projectPath,
      });
    }
  }

  for (const [id, installs] of Object.entries(loadInstalledPlugins())) {
    const install = Array.isArray(installs) ? installs[0] : installs;
    if (!install || !install.installPath) continue;
    const plugin = id.split('@')[0];
    let mcp = null;
    try {
      mcp = JSON.parse(fs.readFileSync(path.join(install.installPath, '.mcp.json'), 'utf8'));
    } catch {
      continue;
    }
    for (const name of Object.keys((mcp && mcp.mcpServers) || {})) {
      push(name, `plugin:${plugin}`, {
        installedAt: Date.parse(install.installedAt) || null,
        removable: false,
        removeCmd: null,
        owner: plugin,
      });
    }
  }

  return out;
}

/** First `description:` line of a SKILL.md / command frontmatter block. */
function frontmatterDescription(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    if (!head.startsWith('---')) return null;
    const end = head.indexOf('\n---', 3);
    const block = end === -1 ? head : head.slice(0, end);
    const match = block.match(/^description:[ \t]*(.*)$/m);
    if (!match) return null;
    let value = match[1].trim();
    // YAML block scalars (`description: >` / `|`) carry the text on following lines.
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const rest = block.slice(match.index + match[0].length).split('\n');
      const lines = [];
      for (const line of rest) {
        if (line.trim() === '') continue;
        if (!/^\s/.test(line)) break;
        lines.push(line.trim());
      }
      value = lines.join(' ');
    }
    return value.replace(/^["']|["']$/g, '').slice(0, 300) || null;
  } catch {
    return null;
  }
}
