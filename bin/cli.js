#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { analyze, suggestions as suggestFrom, DEFAULTS } from '../src/analyze.js';
import { renderReport, renderPrune, setColor } from '../src/term.js';
import { renderHtml } from '../src/html.js';

const KINDS = ['skill', 'command', 'mcp', 'plugin', 'agent'];
const ALIASES = {
  skill: 'skill', skills: 'skill',
  command: 'command', commands: 'command',
  mcp: 'mcp', mcps: 'mcp',
  plugin: 'plugin', plugins: 'plugin',
  agent: 'agent', agents: 'agent',
};

const HELP = `claude-usage — audit which Claude Code skills, commands, plugins and MCP servers you actually use

USAGE
  claude-usage [kinds...] [options]

KINDS
  skills  commands  mcp  plugins  agents        (default: all)

OPTIONS
  --html [file]     write an HTML dashboard (default ./claude-usage.html) and open it
  --json            emit the full analysis as JSON
  --prune           print a copy-pasteable uninstall script for the drop list
  --all             include items you cannot remove directly (plugin-provided, built-ins)
  --sort <key>      verdict | count | recent | name          (default: verdict)
  --stale <days>    idle days before an item is dropped      (default: ${DEFAULTS.staleDays})
  --warm <days>     idle days still counted as active        (default: ${DEFAULTS.warmDays})
  --grace <days>    grace period for newly installed items   (default: ${DEFAULTS.graceDays})
  --no-cache        rescan every transcript from scratch
  --no-color        disable ANSI colour
  -h, --help        show this help
  -v, --version     print the version

EXAMPLES
  claude-usage                     full audit, newest suggestions first
  claude-usage mcp plugins         just servers and plugins
  claude-usage --html              open the dashboard
  claude-usage --prune > clean.sh  review, then run it`;

function parseArgs(argv) {
  const opts = {
    kinds: [], html: null, json: false, prune: false, all: false,
    sort: 'verdict', color: process.stdout.isTTY && !process.env.NO_COLOR, noCache: false,
    thresholds: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '-v' || arg === '--version') return { version: true };
    else if (arg === '--json') opts.json = true;
    else if (arg === '--prune') opts.prune = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--no-cache') opts.noCache = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--sort') opts.sort = next();
    else if (arg === '--stale') opts.thresholds.staleDays = Number(next());
    else if (arg === '--warm') opts.thresholds.warmDays = Number(next());
    else if (arg === '--grace') opts.thresholds.graceDays = Number(next());
    else if (arg === '--html') {
      const value = argv[i + 1];
      opts.html = value && !value.startsWith('-') && !ALIASES[value] ? argv[++i] : 'claude-usage.html';
    } else if (ALIASES[arg]) opts.kinds.push(ALIASES[arg]);
    else if (arg.startsWith('-')) return { error: `unknown option: ${arg}` };
    else return { error: `unknown argument: ${arg}` };
  }
  if (!opts.kinds.length) opts.kinds = KINDS;
  for (const [key, value] of Object.entries(opts.thresholds)) {
    if (!Number.isFinite(value) || value < 0) return { error: `--${key.replace('Days', '')} needs a positive number` };
  }
  if (!['verdict', 'count', 'recent', 'name'].includes(opts.sort)) {
    return { error: `--sort must be one of: verdict, count, recent, name` };
  }
  return opts;
}

function progress(scannedTarget) {
  if (!process.stderr.isTTY) return null;
  let shown = false;
  return (done, total, scanned) => {
    if (scanned < scannedTarget) return;
    shown = true;
    process.stderr.write(`\r  scanning transcripts ${done}/${total}…`);
    if (done === total) process.stderr.write(`\r${' '.repeat(40)}\r`);
  };
}

function openFile(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [file], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Opening is a convenience; the path is printed regardless.
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  if (opts.error) {
    console.error(`claude-usage: ${opts.error}\n\nRun with --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (opts.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return console.log(pkg.version);
  }

  setColor(opts.color);
  const result = await analyze({ ...opts.thresholds, noCache: opts.noCache, onProgress: progress(20) });
  const inKinds = result.items.filter((i) => opts.kinds.includes(i.kind));
  const suggestions = suggestFrom(inKinds);
  const view = { kinds: opts.kinds, sort: opts.sort, showAll: opts.all, suggestions };

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: result.now, transcripts: result.fileCount, items: inKinds, suggestions }, null, 2));
    return;
  }
  if (opts.prune) {
    if (!suggestions.length) {
      console.error('claude-usage: nothing to prune.');
      return;
    }
    console.log(renderPrune(suggestions));
    return;
  }
  if (opts.html) {
    const file = path.resolve(opts.html);
    fs.writeFileSync(file, renderHtml(result, view));
    console.log(`dashboard written to ${file}`);
    openFile(file);
    return;
  }
  console.log(renderReport(result, view));
}

main().catch((error) => {
  console.error(`claude-usage: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
