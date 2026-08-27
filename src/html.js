import { compact, scopeNote } from './format.js';

const STYLE = `
:root{--bg:#fbfbfa;--panel:#fff;--ink:#1a1a19;--muted:#6b6b66;--line:#e6e5e1;
--keep:#1a7f4b;--review:#a86b00;--drop:#c0392b;--new:#2b6cb0;--accent:#c96442;
--bar:#d9d7d1;--radius:10px}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#191917;--panel:#212220;
--ink:#f0efec;--muted:#a3a29c;--line:#33342f;--keep:#4ade80;--review:#fbbf24;--drop:#f87171;
--new:#60a5fa;--accent:#e08a68;--bar:#3a3b36}}
:root[data-theme=dark]{--bg:#191917;--panel:#212220;--ink:#f0efec;--muted:#a3a29c;--line:#33342f;
--keep:#4ade80;--review:#fbbf24;--drop:#f87171;--new:#60a5fa;--accent:#e08a68;--bar:#3a3b36}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-bottom:28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.card .n{font-size:26px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:20px;overflow:hidden}
.phead{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line)}
.phead h2{font-size:14px;margin:0;text-transform:uppercase;letter-spacing:.07em}
.pill{font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:11px;text-transform:uppercase;
letter-spacing:.06em;padding:9px 16px;border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap;user-select:none}
th:hover{color:var(--ink)}
td{padding:9px 16px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
tr:last-child td{border-bottom:0}
td.name{font-weight:500;white-space:normal;min-width:180px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.why{color:var(--muted);font-size:12.5px;white-space:normal}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:7px;vertical-align:middle}
.keep{background:var(--keep)}.review{background:var(--review)}.drop{background:var(--drop)}.new{background:var(--new)}
.v-keep{color:var(--keep)}.v-review{color:var(--review)}.v-drop{color:var(--drop)}.v-new{color:var(--new)}
.spark{display:inline-flex;align-items:flex-end;gap:1.5px;height:16px}
.spark i{width:4px;background:var(--bar);border-radius:1px;min-height:1px}
.spark i.on{background:var(--accent)}
.scope{color:var(--muted);font-size:12px}
.sug{padding:0;margin:0}
.sug li{list-style:none;display:flex;align-items:baseline;justify-content:space-between;gap:16px;
flex-wrap:wrap;padding:9px 16px;border-bottom:1px solid var(--line)}
.sug li:last-child{border-bottom:0}
.sug .t{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.sug .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);flex:none}
.sug .r{color:var(--muted);font-size:12.5px}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);
border:1px solid var(--line);border-radius:6px;padding:3px 7px;color:var(--muted);
max-width:100%;overflow-x:auto;white-space:nowrap}
details{border-top:1px solid var(--line)}
details summary{padding:11px 16px;cursor:pointer;color:var(--muted);font-size:12.5px;user-select:none}
details summary:hover{color:var(--ink)}
details[open] summary{border-bottom:1px solid var(--line)}
.empty{padding:28px 16px;text-align:center;color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:32px}
`;

const SCRIPT = `
const fmt = n => n < 1000 ? String(n) : n < 10000 ? (n/1000).toFixed(1)+'k' : Math.round(n/1000)+'k';
function ago(ts, now){
  if(!ts) return 'never';
  const d = Math.floor((now-ts)/86400000);
  if(d<=0) return 'today'; if(d===1) return 'yesterday';
  if(d<30) return d+'d ago'; if(d<365) return Math.floor(d/30)+'mo ago';
  return (d/365).toFixed(1).replace(/\\.0$/,'')+'y ago';
}
function spark(trend){
  const max = Math.max(...trend, 1);
  return '<span class="spark">' + trend.map(v =>
    '<i class="'+(v?'on':'')+'" style="height:'+Math.max(1, Math.round(v/max*16))+'px"></i>').join('') + '</span>';
}
const ORDER = {drop:0, review:1, new:2, keep:3};
function render(kind, sortKey, dir){
  const box = document.querySelector('[data-kind="'+kind+'"]');
  if(!box) return;
  const rows = DATA.items.filter(i => i.kind === kind);
  const cmp = {
    verdict: (a,b) => ORDER[a.verdict]-ORDER[b.verdict] || b.count-a.count,
    name: (a,b) => a.display.localeCompare(b.display),
    count: (a,b) => b.count-a.count,
    last: (a,b) => (b.lastUsed||0)-(a.lastUsed||0),
    cost: (a,b) => (b.contextCost||0)-(a.contextCost||0),
  }[sortKey] || ((a,b)=>0);
  rows.sort((a,b) => cmp(a,b) * dir);
  box.querySelector('tbody').innerHTML = rows.map(i => \`<tr>
    <td class="name"><span class="dot \${i.verdict}"></span>\${esc(i.display)}</td>
    <td class="num">\${i.count ? fmt(i.count)+'&times;' : '&mdash;'}</td>
    <td>\${spark(i.trend)}</td>
    <td>\${ago(i.lastUsed, DATA.now)}</td>
    <td class="scope">\${esc(i.scopeNote||'')}</td>
    <td class="num">\${i.contextCost ? fmt(i.contextCost) : ''}</td>
    <td class="why v-\${i.verdict}">\${esc(i.reason)}</td></tr>\`).join('');
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const state = {};
document.querySelectorAll('[data-kind]').forEach(box => {
  const kind = box.dataset.kind;
  state[kind] = {key:'verdict', dir:1};
  box.querySelectorAll('th[data-sort]').forEach(th => {
    th.onclick = () => {
      const s = state[kind];
      s.dir = s.key === th.dataset.sort ? -s.dir : 1;
      s.key = th.dataset.sort;
      render(kind, s.key, s.dir);
    };
  });
  render(kind, 'verdict', 1);
});
`;


/** Suggestions shown before the list folds into a <details>. */
const SUGGESTION_PREVIEW = 15;

const KIND_LABEL = {
  skill: 'Skills',
  command: 'Commands',
  mcp: 'MCP servers',
  plugin: 'Plugins',
  agent: 'Agents',
};

/** Names come from user config, so `</script>` must not be able to close the tag. */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function esc(text) {
  return String(text == null ? '' : text).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
}



export function renderHtml({ items, now, fileCount }, { kinds, showAll, suggestions }) {
  const visible = [];
  for (const kind of kinds) {
    let group = items.filter((i) => i.kind === kind);
    if (!showAll) group = group.filter((i) => i.removable || i.count > 0);
    visible.push(...group);
  }

  const tally = { keep: 0, review: 0, drop: 0, new: 0 };
  for (const item of visible) tally[item.verdict] = (tally[item.verdict] || 0) + 1;
  const reclaim = suggestions.reduce((sum, i) => sum + (i.contextCost || 0), 0);

  const payload = {
    now,
    items: visible.map((i) => ({
      kind: i.kind,
      display: i.display,
      count: i.count,
      lastUsed: i.lastUsed,
      trend: i.trend,
      verdict: i.verdict,
      reason: i.reason,
      contextCost: i.contextCost || 0,
      scopeNote: scopeNote(i),
    })),
  };

  const cards = [
    { n: tally.keep, l: 'keep', cls: 'v-keep' },
    { n: tally.review, l: 'review', cls: 'v-review' },
    { n: tally.drop, l: 'drop', cls: 'v-drop' },
    { n: suggestions.length, l: 'removable now', cls: '' },
    { n: compact(reclaim), l: 'tokens reclaimable', cls: '' },
  ]
    .map((c) => `<div class="card"><div class="n ${c.cls}">${c.n}</div><div class="l">${c.l}</div></div>`)
    .join('');

  const tables = kinds
    .map((kind) => {
      const count = payload.items.filter((i) => i.kind === kind).length;
      if (!count) return '';
      return `<section class="panel" data-kind="${kind}">
  <div class="phead"><h2>${KIND_LABEL[kind] || kind}</h2><span class="pill">${count}</span></div>
  <div class="scroll"><table>
    <thead><tr>
      <th data-sort="name">Name</th><th data-sort="count">Uses</th><th>12 weeks</th>
      <th data-sort="last">Last used</th><th>Source</th><th data-sort="cost">Ctx tok</th>
      <th data-sort="verdict">Verdict</th>
    </tr></thead><tbody></tbody>
  </table></div></section>`;
    })
    .join('\n');

  const sugRow = (i) => `<li><div class="t"><span class="k">${esc(i.kind)}</span><strong>${esc(i.display)}</strong>
    <span class="r">${esc(i.reason)}${i.contextCost ? ` · ~${compact(i.contextCost)} tok` : ''}</span></div>
    <code>${esc(i.removeCmd)}</code></li>`;
  const head = suggestions.slice(0, SUGGESTION_PREVIEW);
  const tail = suggestions.slice(SUGGESTION_PREVIEW);
  const sugList = suggestions.length
    ? `<ul class="sug">${head.map(sugRow).join('')}</ul>` +
      (tail.length
        ? `<details><summary>${tail.length} more &mdash; lower value, same verdict</summary>
      <ul class="sug">${tail.map(sugRow).join('')}</ul></details>`
        : '')
    : '<div class="empty">Nothing to uninstall — everything installed is in use.</div>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code usage audit</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
<h1>Claude Code usage audit</h1>
<div class="sub">${fileCount} transcripts scanned · generated ${new Date(now).toISOString().slice(0, 10)}</div>
<div class="cards">${cards}</div>
<section class="panel">
  <div class="phead"><h2>Uninstall suggestions</h2><span class="pill">${suggestions.length}</span></div>
  ${sugList}
</section>
${tables}
<footer>claude-usage · click a column header to sort</footer>
</div>
<script>const DATA = ${jsonForScript(payload)};${SCRIPT}</script>
</body></html>`;
}
