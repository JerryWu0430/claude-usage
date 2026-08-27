import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = os.homedir();
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const CONFIG_FILE = path.join(HOME, '.claude.json');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const CACHE_FILE = path.join(CLAUDE_DIR, '.claude-usage-cache.json');

/** Read JSON, returning `fallback` on any failure. Config files are user-editable and often absent. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Creation time in ms, falling back to mtime on filesystems without birthtime.
 * Uses lstat so a symlinked skill reports when it was linked here, not when the
 * upstream skill was written.
 */
export function createdAt(file) {
  try {
    const s = fs.lstatSync(file);
    const birth = s.birthtimeMs;
    return birth && birth > 0 ? birth : s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 'dir' | 'file' | null, resolving symlinks. Skills are commonly symlinked into
 * ~/.claude/skills from a separate library, and a Dirent reports those as neither.
 */
export function entryKind(dirent, fullPath) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  if (!dirent.isSymbolicLink()) return null;
  try {
    const s = fs.statSync(fullPath);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
  } catch {
    return null; // dangling symlink
  }
}

/** Where a symlink points, or null for a real file. */
export function linkTarget(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : null;
  } catch {
    return null;
  }
}

export function loadConfig() {
  return readJson(CONFIG_FILE, {}) || {};
}

export function loadInstalledPlugins() {
  const data = readJson(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), {});
  return (data && data.plugins) || {};
}
