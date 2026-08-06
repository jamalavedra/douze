/**
 * #ReviewApp — one file, no framework, no build step. The page is a list, one primary button, and
 * two editable fields; a component tree would be more code to reach the same screen. Inlined as a
 * string so `tsc` needs no asset-copy step and douzed needs no __dirname lookup.
 *
 * douzed serves this at /review/:sessionId?token=… and the session id and token are inlined here,
 * so the page authenticates its own fetches and the reader never opens a terminal.
 *
 * The audience is someone who has never heard the words "endpoint" or "side effect". Every string
 * on the first screen is plain English; the developer-facing detail lives behind one <details>.
 */
export const reviewPage = (session: { id: string; token: string }): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What Claude can do</title>
<style>
${STYLE}
</style>
</head>
<body>
<!-- Both lines are rewritten in place when the list loads and again after saving, and that
     rewrite IS the confirmation the save worked — so it has to be announced, not just shown. -->
<div aria-live="polite">
  <h1 id="title">What Claude can do</h1>
  <p class="sub" id="sub">Working out what this site can do&hellip;</p>
</div>
<ul id="list"></ul>
<div class="actions" id="actions" hidden>
  <button type="button" class="primary" id="go" disabled>Nothing selected</button>
</div>
<div class="actions" id="after" hidden>
  <button type="button" class="quiet" id="back">Change what&rsquo;s on</button>
</div>
<p id="error" role="alert"></p>
<script>
const SESSION = ${inline(session.id)};
const TOKEN = ${inline(session.token)};
${SCRIPT}
</script>
</body>
</html>
`

/**
 * The two dead ends a browser can reach: a link whose token no longer matches — a bookmark kept
 * across a reinstall, a URL copied out of a chat — and a session with nothing recorded in it. Both
 * are a person looking at a blank tab wondering what they did wrong, so both get a sentence and a
 * next move. Neither ever says "token": the reader never chose to have one.
 */
export const noticePage = (headline: string, next: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(headline)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>${escapeText(headline)}</h1>
<p class="sub">${escapeText(next)}</p>
</body>
</html>
`

/** Both pages, one look. Type scale 13/15/17/22, spacing in multiples of 4px. */
const STYLE = `  :root {
    color-scheme: light dark;
    --bg: light-dark(#ffffff, #16181c);
    --fg: light-dark(#15171c, #f1f3f6);
    --muted: light-dark(#565e6c, #a3abba);
    --line: light-dark(#d9dce3, #363b45);
    --accent: light-dark(#1a56c4, #86aaf7);
    --safe: light-dark(#166a44, #6ec99c);
    --changes: light-dark(#82500a, #e2a862);
    --danger: light-dark(#a11f1f, #f28c8c);
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--fg); margin: 0 auto; max-width: 660px;
    padding: 40px 20px 80px; font: 15px/1.55 ui-sans-serif, system-ui, sans-serif;
  }
  h1 { font-size: 22px; line-height: 1.25; margin: 0 0 8px; }
  .sub { font-size: 15px; color: var(--muted); margin: 0 0 28px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border-top: 1px solid var(--line); padding: 20px 0; }
  li:last-of-type { border-bottom: 1px solid var(--line); }
  .head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
  .desc { font-size: 17px; margin: 0; flex: 1; }
  .meta { font-size: 13px; color: var(--muted); margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .name { font-family: ui-monospace, monospace; font-size: 13px; color: var(--muted); }
  .chip { display: inline-flex; gap: 4px; align-items: baseline; font-size: 13px; }
  .chip.read { color: var(--safe); }
  .chip.write { color: var(--changes); }
  .chip.destructive { color: var(--danger); }
  .warn { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
  .consequence { font-size: 13px; color: var(--changes); margin: 8px 0 0; }
  .toggle { display: inline-flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); cursor: pointer; white-space: nowrap; }
  .toggle input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); cursor: pointer; }
  details { margin: 12px 0 0; }
  summary { font-size: 13px; color: var(--muted); cursor: pointer; }
  pre { background: light-dark(#f4f5f8, #1e2128); border-radius: 6px; padding: 12px; margin: 8px 0 0; overflow: auto; max-height: 240px; font-size: 13px; }
  .actions { margin: 32px 0 0; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .primary {
    font: inherit; font-size: 17px; padding: 12px 24px; border: 1px solid transparent; border-radius: 8px;
    background: var(--accent); color: var(--bg); cursor: pointer;
  }
  .primary[disabled] { background: none; color: var(--muted); border-color: var(--line); cursor: not-allowed; }
  .quiet { font: inherit; font-size: 15px; padding: 8px 0; border: none; background: none; color: var(--accent); text-decoration: underline; cursor: pointer; }
  #error { font-size: 15px; color: var(--danger); margin: 16px 0 0; }
  /* A dashed rule alone reads as decoration; the pencil and the text cursor say "you can type
     here" before anyone clicks, and the affordance firms up under the pointer. */
  [contenteditable] { border-bottom: 1px dashed var(--line); outline: none; cursor: text; }
  [contenteditable]::after { content: ' \\270e'; color: var(--muted); font-size: 13px; }
  [contenteditable]:hover { border-bottom-color: var(--accent); }
  [contenteditable]:focus { border-bottom-style: solid; }
  [contenteditable]:focus::after { content: none; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  [hidden] { display: none !important; }`

const SCRIPT = `
// Word AND shape: the category is never carried by colour alone.
const KINDS = {
  read: { word: 'Reads information', mark: '\\u00b7' },
  write: { word: 'Makes changes', mark: '\\u25b2' },
  destructive: { word: 'Deletes things', mark: '\\u25a0' },
};
const WARNINGS = [
  ['sparse', 'Only seen once'],
  ['derived_name', 'Name is a guess'],
  ['unverified', 'Not checked yet'],
];

let state = null;
let seeded = false;
const chosen = new Set();

const el = (tag, props, children) => {
  const node = Object.assign(document.createElement(tag), props || {});
  for (const child of children || []) node.append(child);
  return node;
};
const byId = (id) => document.getElementById(id);
const fail = (sentence) => { byId('error').textContent = sentence; };

async function api(path, body) {
  const init = { headers: { 'x-douze-token': TOKEN } };
  if (body) {
    init.method = 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function editable(tag, candidate, field, className) {
  const node = el(tag, { className: className, textContent: candidate[field], contentEditable: 'plaintext-only' });
  node.setAttribute('aria-label', field === 'name' ? 'Short name for this' : 'What this does');
  node.addEventListener('blur', async () => {
    const value = node.textContent.trim();
    if (value === candidate[field] || value === '') { node.textContent = candidate[field]; return; }
    try {
      await api('/api/review/' + SESSION + '/edit', { name: candidate.name, field: field, value: value });
      fail('');
      await load();
    } catch (error) {
      node.textContent = candidate[field];
      fail("Couldn't save that. Nothing has changed — try again.");
    }
  });
  return node;
}

function item(candidate) {
  const kind = KINDS[candidate.side_effect] || KINDS.read;
  const consequence = el('p', {
    className: 'consequence',
    textContent: 'Claude will be able to do this on your real account.',
    hidden: candidate.side_effect === 'read' || !chosen.has(candidate.name),
  });

  const box = el('input', { type: 'checkbox', checked: chosen.has(candidate.name) });
  box.setAttribute('aria-label', 'Turn on: ' + candidate.description);
  const label = el('span', { textContent: box.checked ? 'On' : 'Off' });
  box.addEventListener('change', () => {
    if (box.checked) chosen.add(candidate.name); else chosen.delete(candidate.name);
    label.textContent = box.checked ? 'On' : 'Off';
    consequence.hidden = candidate.side_effect === 'read' || !box.checked;
    syncButton();
  });

  const seen = candidate.observations === 1 ? 'Seen once' : 'Seen ' + candidate.observations + ' times';
  const meta = el('p', { className: 'meta' }, [
    el('span', { className: 'chip ' + candidate.side_effect }, [
      el('span', { textContent: kind.mark, ariaHidden: 'true' }),
      el('span', { textContent: kind.word }),
    ]),
    el('span', { textContent: seen }),
    editable('code', candidate, 'name', 'name'),
  ]);

  const parts = [
    el('div', { className: 'head' }, [
      editable('p', candidate, 'description', 'desc'),
      el('label', { className: 'toggle' }, [box, label]),
    ]),
    meta,
  ];
  for (const [flag, sentence] of WARNINGS) {
    if (candidate.flags[flag]) parts.push(el('p', { className: 'warn', textContent: sentence }));
  }
  parts.push(consequence);
  parts.push(
    el('details', {}, [
      el('summary', { textContent: 'Technical details' }),
      el('p', { className: 'warn', textContent: candidate.request.method + ' ' + candidate.request.path }),
      el('pre', { textContent: JSON.stringify(candidate.sample, null, 2) }),
      el('pre', { textContent: 'Input schema\\n' + JSON.stringify(candidate.request.input_schema, null, 2) }),
    ]),
  );
  return el('li', {}, parts);
}

function syncButton() {
  const go = byId('go');
  go.disabled = chosen.size === 0;
  go.textContent = chosen.size === 0 ? 'Nothing selected' : 'Turn these on';
}

function render() {
  byId('title').textContent = 'What Claude can do on ' + state.site;
  byId('sub').textContent =
    'Douze watched you use this site and worked out what it could do for you. Turn on the ones you want. ' +
    'Everything it saw stayed on your computer.';
  const list = byId('list');
  list.textContent = '';
  for (const candidate of state.candidates) list.append(item(candidate));
  byId('actions').hidden = false;
  byId('after').hidden = true;
  syncButton();
}

async function load() {
  state = await api('/api/review/' + SESSION);
  const names = new Set(state.candidates.map((c) => c.name));
  for (const name of chosen) if (!names.has(name)) chosen.delete(name);
  // Reads are pre-selected once; a later reload must not undo an unchecked box.
  if (!seeded) {
    seeded = true;
    for (const candidate of state.candidates) if (candidate.side_effect === 'read') chosen.add(candidate.name);
  }
  render();
}

function done(count) {
  byId('title').textContent =
    'Done — Claude can do ' + count + ' thing' + (count === 1 ? '' : 's') + ' on ' + state.site + ' now.';
  byId('sub').textContent = 'Open Claude Desktop and ask it. Nothing else to install.';
  byId('list').textContent = '';
  byId('actions').hidden = true;
  byId('after').hidden = false;
}

byId('go').addEventListener('click', async () => {
  const all = state.candidates.map((c) => c.name);
  try {
    fail('');
    await api('/api/review/' + SESSION + '/enable', { names: all.filter((n) => chosen.has(n)) });
    const off = all.filter((n) => !chosen.has(n));
    if (off.length > 0) await api('/api/review/' + SESSION + '/disable', { names: off });
    const report = await api('/api/review/' + SESSION + '/save', {});
    done(report.tools.length);
  } catch (error) {
    fail("Couldn't save that. Nothing has changed — try again.");
  }
});

byId('back').addEventListener('click', () => { fail(''); render(); });

load().catch(() =>
  fail(
    "Couldn't load what this site can do. Try reloading this page. " +
      "If that doesn't help, click the Douze button in Chrome and record the site again.",
  ),
);
`

/**
 * JSON.stringify escapes quotes and backslashes but not "<", so a value containing a closing
 * script tag would end the block and everything after it would be markup. Unreachable through any
 * input today; escaping it makes that a property of the page rather than of the id generator.
 */
const inline = (value: string): string => JSON.stringify(value).replaceAll('<', '\\u003c')

const escapeText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
