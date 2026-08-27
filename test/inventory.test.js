import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Point the whole module graph at a throwaway home before importing it, so this
// asserts against the fixture rather than the machine running the tests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
process.env.HOME = root;
process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');

const claude = process.env.CLAUDE_CONFIG_DIR;
const library = path.join(root, 'library', 'linked-skill');
fs.mkdirSync(library, { recursive: true });
fs.writeFileSync(path.join(library, 'SKILL.md'), '---\nname: linked-skill\ndescription: from a library\n---\n');

fs.mkdirSync(path.join(claude, 'skills', 'real skill'), { recursive: true });
fs.writeFileSync(
  path.join(claude, 'skills', 'real skill', 'SKILL.md'),
  '---\nname: real skill\ndescription: >\n  a folded\n  description\n---\n'
);
fs.mkdirSync(path.join(claude, 'skills', 'not-a-skill'), { recursive: true }); // no SKILL.md
fs.symlinkSync(library, path.join(claude, 'skills', 'linked-skill'));

fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
fs.writeFileSync(path.join(claude, 'commands', 'ship.md'), '---\ndescription: ship it\n---\n');
fs.writeFileSync(path.join(claude, 'commands', '_shared.md'), 'not a command\n');
fs.mkdirSync(path.join(claude, 'commands', 'group'), { recursive: true });
fs.writeFileSync(path.join(claude, 'commands', 'group', 'nested.md'), 'nested\n');

const { collectInventory } = await import('../src/inventory.js');
const inventory = collectInventory();

test('symlinked skills are discovered like real directories', () => {
  assert.ok(inventory.has('skill:linked-skill'), 'symlinked skill missing');
  assert.ok(inventory.has('skill:real skill'), 'plain skill missing');
});

test('a symlinked skill is unlinked, not recursively deleted', () => {
  assert.equal(inventory.get('skill:linked-skill').removeCmd, `rm ${path.join(claude, 'skills', 'linked-skill')}`);
  assert.ok(fs.existsSync(path.join(library, 'SKILL.md')), 'source library must survive');
});

test('paths with spaces are quoted in the uninstall command', () => {
  assert.equal(inventory.get('skill:real skill').removeCmd, `rm -rf '${path.join(claude, 'skills', 'real skill')}'`);
});

test('a directory without SKILL.md is not a skill', () => {
  assert.ok(!inventory.has('skill:not-a-skill'));
});

test('folded YAML descriptions are read across lines', () => {
  assert.equal(inventory.get('skill:real skill').description, 'a folded description');
  assert.equal(inventory.get('skill:linked-skill').description, 'from a library');
});

test('commands include nested dirs and exclude underscore includes', () => {
  assert.ok(inventory.has('command:ship'));
  assert.ok(inventory.has('command:group:nested'));
  assert.ok(!inventory.has('command:_shared'));
});

test('the CLI survives a machine with no Claude Code data at all', () => {
  // A subprocess is the only honest way to test this: the module graph reads the
  // config location once, at import.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-empty-'));
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, '--no-color'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: empty, CLAUDE_CONFIG_DIR: path.join(empty, '.claude') },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Nothing to uninstall/);
});

test('--json on an empty machine is still valid JSON', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-empty-json-'));
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: empty, CLAUDE_CONFIG_DIR: path.join(empty, '.claude') },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).items, []);
});

test('an unknown option exits non-zero instead of running an audit', () => {
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, '--nope'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown option/);
});
