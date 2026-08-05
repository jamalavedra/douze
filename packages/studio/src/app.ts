/**
 * #ReviewApp SPA — one file, no framework, no build step. The review surface is a list, three
 * buttons, and two editable fields; a component tree would be more code to reach the same screen.
 * Inlined as a string so `tsc` needs no asset-copy step and the server needs no __dirname lookup.
 */
export const REVIEW_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Recon Studio — review</title>
<style>
  :root { color-scheme: light dark; --line: #8884; --read: #2a7; --write: #b83; --destructive: #c44; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; max-width: 960px; }
  header { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: none; cursor: pointer; }
  button[disabled] { opacity: .4; cursor: not-allowed; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .card.approved { border-color: var(--read); }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .name { font-weight: 600; font-family: ui-monospace, monospace; }
  .tag { font-size: 12px; padding: 1px 7px; border-radius: 99px; border: 1px solid currentColor; }
  .read { color: var(--read); } .write { color: var(--write); } .destructive { color: var(--destructive); }
  .meta { font-size: 13px; opacity: .75; }
  [contenteditable] { outline: none; border-bottom: 1px dashed var(--line); }
  [contenteditable]:focus { border-bottom-style: solid; }
  pre { background: #8881; padding: 10px; border-radius: 6px; overflow: auto; max-height: 220px; font-size: 12px; }
  details summary { cursor: pointer; font-size: 13px; opacity: .8; margin-top: 8px; }
  .edited { font-size: 12px; color: var(--write); }
  #status { font-size: 13px; opacity: .8; }
</style>
</head>
<body>
<header>
  <h1>Recon Studio</h1>
  <span class="meta" id="target"></span>
  <span style="flex:1"></span>
  <button id="approve-reads">Approve all reads</button>
  <button id="save">Save recipe</button>
  <span id="status"></span>
</header>
<main id="list"></main>
<script>
const el = (tag, props, children) => {
  const node = Object.assign(document.createElement(tag), props || {});
  for (const child of children || []) node.append(child);
  return node;
};
const status = (text) => { document.getElementById('status').textContent = text; };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

function editable(candidate, field, value) {
  const node = el('span', { contentEditable: 'plaintext-only', textContent: value, className: field });
  node.addEventListener('blur', async () => {
    if (node.textContent === value) return;
    try {
      await api('/api/candidates/' + encodeURIComponent(candidate.name) + '/edit', { field: field, value: node.textContent });
      status('saved ' + field + ' on ' + candidate.name);
      load();
    } catch (error) { status(error.message); }
  });
  return node;
}

function card(candidate) {
  const tag = el('span', { className: 'tag ' + candidate.side_effect, textContent: candidate.side_effect });
  const head = el('div', { className: 'row' }, [
    el('span', { className: 'name' }, [editable(candidate, 'name', candidate.name)]),
    tag,
    el('span', { className: 'meta', textContent: 'confidence ' + candidate.confidence + ' · ' + candidate.observations + ' observation(s)' }),
  ]);
  if (candidate.flags.sparse) head.append(el('span', { className: 'tag write', textContent: 'sparse' }));
  if (candidate.flags.derived_name) head.append(el('span', { className: 'tag write', textContent: 'derived name' }));
  if (candidate.flags.unverified) head.append(el('span', { className: 'tag write', textContent: 'unverified' }));

  const body = el('div', {}, [editable(candidate, 'description', candidate.description)]);
  const request = el('div', { className: 'meta', textContent: candidate.request.method + ' ' + candidate.request.path });

  const evidence = el('div', { className: 'meta' });
  if (candidate.annotation) evidence.append(el('div', { textContent: 'note: ' + candidate.annotation }));
  if (candidate.provenance) evidence.append(el('div', { textContent: 'clicked: "' + candidate.provenance + '"' + (candidate.route ? ' on ' + candidate.route : '') }));
  if (candidate.flags.user_edited.length) evidence.append(el('div', { className: 'edited', textContent: 'user edited: ' + candidate.flags.user_edited.join(', ') }));

  const sample = el('details', {}, [
    el('summary', { textContent: 'redacted sample exchange (' + candidate.sample.status + ' ' + candidate.sample.url + ')' }),
    el('pre', { textContent: JSON.stringify(candidate.sample, null, 2) }),
    el('pre', { textContent: 'input schema\\n' + JSON.stringify(candidate.request.input_schema, null, 2) }),
  ]);

  const button = el('button', { textContent: candidate.approved ? 'Unapprove' : 'Approve' });
  button.addEventListener('click', async () => {
    const verb = candidate.approved ? 'unapprove' : 'approve';
    try {
      await api('/api/candidates/' + encodeURIComponent(candidate.name) + '/' + verb);
      status(verb + 'd ' + candidate.name);
      load();
    } catch (error) { status(error.message); }
  });

  return el('section', { className: 'card' + (candidate.approved ? ' approved' : '') }, [head, body, request, evidence, sample, el('div', { className: 'row', style: 'margin-top:10px' }, [button])]);
}

async function load() {
  const state = await (await fetch('/api/state')).json();
  document.getElementById('target').textContent = state.recipe + ' → ' + state.base_url;
  const list = document.getElementById('list');
  list.textContent = '';
  for (const candidate of state.candidates) list.append(card(candidate));
}

document.getElementById('approve-reads').addEventListener('click', async () => {
  const result = await api('/api/approve-reads');
  status('approved ' + result.approved.length + ' read tool(s); ' + result.skipped.length + ' need individual approval');
  load();
});

document.getElementById('save').addEventListener('click', async () => {
  try {
    const report = await api('/api/save');
    status('wrote ' + report.path + (report.conflicts.length ? ' — ' + report.conflicts.length + ' conflict(s) left unresolved' : ''));
    load();
  } catch (error) { status(error.message); }
});

load();
</script>
</body>
</html>
`
