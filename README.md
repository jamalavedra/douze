# Douze

**Use a website for five minutes. Afterwards, your AI assistant can use it too.**

You already have accounts on things — an order dashboard, a support inbox, a billing console, an
internal admin page. Claude, Cursor, VS Code, ChatGPT — none of them can touch any of it. Douze
fixes that by watching you do the work once.

Open the site you're signed into, click **Watch this site**, then do what you normally do: click
around, open a few orders, file a ticket. Click **Done**. Douze shows you a list of the actions it
saw — "list orders", "create ticket", "refund an order" — and you tick the ones you want allowed.
From then on you can type *"refund order 1042"* into your assistant and it happens, in your
account.

Douze is one Chrome extension. There is nothing else to install and no terminal in the consumer
path. The one exception is the developer bridge, and it says so where it appears.

## What Douze does not do

This is the part worth reading carefully.

- **Your screen is never read — the traffic is, and it is kept.** Douze doesn't look at pixels or
  at what you have on screen. It watches the requests the site makes behind the scenes, and it
  stores them: while you record, full request and response bodies go into the extension's own
  database, and turning a skill on keeps one complete exchange as that skill's example answer.
  Passwords, cookies, tokens and anything else shaped like a credential are stripped before
  anything is written — with one exception, which Douze always shows you and asks about by name.
  See *A token the site hardcodes* below. A customer's name, their email address, their order — those are not, and
  they stay in this browser until you delete the recording on the Douze data page. Only the
  inferred schema is a "shape"; the example is the real thing.
- **Where a site keeps its tokens, Douze learns the LOCATION, never the value.** Many sites need a
  token on every request beyond the cookie the browser sends. Douze can find one in a readable
  cookie, in `localStorage`/`sessionStorage`, or in a `<meta name="csrf-token">` tag, and it records
  *where* it lives so it can re-read the current value at the moment a skill runs. A site that
  hardcodes a token in its own JavaScript — x.com does — is out of reach, and a skill that needs one
  will be refused with a 403 that says so.
- **A token the site hardcodes is kept only if you say so.** Some sites authorise every request with a
  fixed token embedded in their own JavaScript — x.com does, and refuses every call without it. There
  is nowhere to re-read that from, so using the site means keeping a copy. Douze will not do that
  behind your back, because no rule can tell a public application token from your own session token:
  both are just strings in an `authorization` header. So the value waits in memory, the review page
  shows it to you in full, and you decide. Say no and it is gone when you close the browser. Say yes
  and the copy is kept for that one site — never in a skills file, so what you export still contains
  no credentials.
- **One kind of cookie is read, and only its name is kept.** Some sites authorise a request with a
  CSRF token they keep in a cookie the page itself can read — X does this, and refuses every call
  whose `x-csrf-token` does not match its `ct0` cookie. Douze records *where* that value lives, by
  name, and re-reads it from the page at the moment it runs. The cookie that actually carries your
  session is `HttpOnly`: the browser sends it, and Douze cannot read it and never tries. What ends
  up in a skill is `document.cookie["ct0"]`, never a value.
- **Your password is never involved.** You never type it into Douze. Douze never asks for one.
- **No cookie or login is stored, copied, or sent anywhere.** Not to us, not to the assistant, not
  to disk.
- **Requests run inside the browser you're already signed into.** That's why no login is needed:
  the site sees an ordinary request from an ordinary tab, exactly as if you'd clicked the button
  yourself. When you sign out, the assistant loses access too.
- **Everything stays on your computer — until you connect a hosted assistant.** What Douze learns
  lives in the extension's own storage in Chrome. There is no account and no upload, and no part of
  Douze reaches the network on its own. That stops being the whole story the moment you connect
  ChatGPT, claude.ai or Dust: from then on **the relay operator and the AI provider both see your
  tool arguments and your full result bodies** — live data pulled from your dashboards a moment
  earlier. The relay can also read and alter them in flight. That is the design, not a bug to be
  patched, and the only remedy is running your own relay or not connecting a hosted assistant at
  all. See [Connecting a hosted assistant](#connecting-a-hosted-assistant-chatgpt-claudeai-dust).
  **The apps in [For developers](#for-developers-claude-code-cursor-vs-code-claude-desktop) are
  not an exception to this either**: Claude Code, Cursor and Claude Desktop are AI assistants
  themselves, so every result a tool hands them goes on to their own model provider — at full
  trust, destructive results included. What stays on your computer is Douze. What your assistant
  does with an answer is your assistant's business, wherever it runs.
- **You choose what it may do, and deleting is the line.** A hosted assistant can look things up
  and make changes on the sites you recorded from the moment you connect it; set that link back to
  read-only whenever you like. Deleting is never possible from one at all. An app paired on this
  computer can delete, and the confirmation that guards it comes from the app doing the calling
  rather than from a dialog Douze shows you — so pair only apps you trust with that.

## Setting it up

Once, in about five minutes. No terminal.

### 1. Add the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `douze-extension` folder.

The Douze icon appears in your toolbar. Pin it — you'll click it a lot.

Leave the folder where it is. Chrome reads it from that spot every time it starts, so moving or
deleting it turns Douze off.

> **Where the folder comes from, honestly:** nowhere yet. There is no Chrome Web Store listing, no
> tagged release, and this repository has no git remote — `git remote -v` prints nothing — so there
> is no published artifact for anyone to download. Today the only way to get the folder is to build
> it: `pnpm install && pnpm release:local` writes `douze-extension.zip` at the repo root and leaves
> the same files in `packages/extension/dist`, which **Load unpacked** takes directly.
> `.github/workflows/release.yml` will attach that one zip to a GitHub Release on any pushed `v*`
> tag, once there is somewhere to push it.

### 2. Teach it a site

1. Open a site you're signed into and go to the page you actually use.
2. Click the Douze icon, then **Watch this site**.
3. Use the site normally for a few minutes. Do the thing you'd want done for you — look up an
   order, file a ticket, whatever it is. Doing it twice or three times helps Douze get it right.
4. Click **Done**. A review page opens.
5. You'll see a plain-English list of what Douze saw, grouped into "Look things up", "Make changes"
   and "Remove things". All of it is selected — turn off anything you would rather it could not do.
   Anything that removes things still asks you to confirm every single time it runs, and a hosted
   assistant cannot run one at all.

That's it. The abilities are live in the extension from that moment; assistants pick them up within
seconds without restarting anything.

## Connecting a hosted assistant (ChatGPT, claude.ai, Dust)

ChatGPT, claude.ai in a browser or on a phone, and Dust cannot start a program on your laptop, so
they reach Douze through a **relay**: the extension dials out to it over one WebSocket, the relay
hands the assistant a URL, and messages pass between the two. Nothing new listens on your machine
and no port is opened.

Click the Douze icon, then **Connect**. The page gives you one URL with a copy button. Paste it in:

| Client | Where |
|---|---|
| ChatGPT | Settings → Plugins → Developer mode, turn it on. Then Settings → Plugins → the **+** beside the search box |
| claude.ai | Settings → Connectors → Add custom connector |
| Dust | Admin → Tools → Add MCP server |

**The relay Douze offers by default is not a company.** It is `https://douze.jamalavedra.com`, a
personal server run by Jaume Alavedra, who wrote Douze — no organisation behind it and no agreement.
Whoever runs a relay can read and alter every message that crosses it, which for Douze means your
tool arguments and your full result bodies. Run your own and type its address into the connect page
if that matters to you; `packages/relay/README.md` is the whole of what you need.

Where the client asks how to sign in, choose **no authentication**. ChatGPT's dialog offers OAuth
first and it will not work — the relay has no OAuth endpoints and nothing to log in to. The URL is
the whole credential.

### When a new skill doesn't show up

Record a site and its tools are live in seconds — but ChatGPT and claude.ai both freeze a
connector's tool list, so they may not notice. ChatGPT re-reads it only when you press **Refresh**
on the app's details page (Settings → Plugins → Douze), and the new tools then arrive **switched
off**, so you have to enable them. claude.ai has no working refresh at all today; its cached list
survives disconnecting, deleting and re-adding the connector.

So Douze always offers two tools whose names never change, which makes a frozen list permanently
usable:

| Tool | What it does |
|---|---|
| `douze_list_skills` | lists every skill available *right now* |
| `douze_run_skill` | runs any skill by name, including one the assistant cannot see |

If an assistant says it has no tool for something you just recorded, tell it to *list your Douze
skills and then run it*. That works with no refresh, on either platform. It is not a way around
anything: a skill run this way goes through the same trust table as a direct call — reads always,
changes only if you allowed them, deleting never from a hosted assistant.

Douze bundles the ChatGPT, Claude and Dust marks to label those instructions, and self-hosts them so
that opening the page tells nobody you did. Those marks belong to OpenAI, Anthropic and Dust; Douze
is not affiliated with, endorsed by, or connected to any of them.

**That URL is the password.** Anyone holding it can call your tools. The relay keeps only a hash of
it, and Douze sends it nowhere else — but a URL in a chat log or a screenshot is a URL someone else
has. The same page rotates it (the old one dies immediately) and stops sharing altogether.

Read [What Douze does not do](#what-douze-does-not-do) before you do this. Connecting is the one
action in Douze that sends your data off the machine.

### What a hosted assistant is allowed to do

| | Hosted assistant (relay) | Local app (bridge) |
|---|---|---|
| look things up | always | always |
| make changes | **yes, from the start** — turn it off per link if you would rather not | always |
| delete or destroy things | **never**, and no setting turns it on | allowed, with `confirm: true` |
| results that look like credentials | the value is masked, the rest of the answer goes through | same |

The asymmetry is deliberate. A destructive tool protects itself by demanding a `confirm: true`
argument — but an argument is something any caller can send, so it is consent, not a lock, and it
is not enough when a third party holds the URL that reaches your account. A program running on your
own computer that you paired in person is a different claim, so that one gets everything.

Douze also refuses to hand back a result that still holds a credential-shaped value. You get an
error naming the tool and where the value was; if it is business data you actually want, allow that
tool's results in the extension.

## For developers: Claude Code, Cursor, VS Code, Claude Desktop

Local MCP clients speak stdio, which a browser extension cannot. `@douze/bridge` is the pipe
between them: stdio on one side, a loopback WebSocket the extension dials on the other. It holds no
recipes, no storage and no policy — the extension keeps all of that.

**This is the only part of Douze that needs a terminal, and it is optional.** A consumer never
touches it.

```jsonc
// .mcp.json, or your client's equivalent
{
  "mcpServers": {
    "douze": { "command": "node", "args": ["/path/to/douze/packages/bridge/dist/index.js"] }
  }
}
```

Build it first with `pnpm --filter @douze/bridge build`; it emits a single self-contained
`dist/index.js`. The package is not published to npm yet, so the `npx @douze/bridge` form its own
README shows does not work today.

The first run prints a pairing code to stderr, where your client's log picks it up:

```
douze-bridge: listening on ws://127.0.0.1:8912/ws
douze-bridge:   Pairing code: 7Q78-PEXT
```

Open the Douze extension and type it in. That happens once per machine. Loopback alone is not
consent — every process on your machine can dial `127.0.0.1`, and the first one to attach without a
code would inherit the right to run destructive tools. `packages/bridge/README.md` has the pairing
mechanics and what an attacker on the same machine can and cannot do.

A bridge is per client: Claude Code and Cursor each spawn one, the extension attaches to each, and
they share one set of recipes.

## When something goes wrong

- **Nothing was recorded.** Douze only watches the tab you clicked **Watch this site** on. Make
  sure you're on that tab, that you clicked **Done** rather than closing the window, and that the
  site actually loaded something while you watched — clicking around a page it has already cached
  may make no requests at all. Moving between pages forces fresh ones.
- **It asks permission for a site you didn't name.** Expected. A dashboard almost never serves its
  own data: `dashboard.example.com` asks `api.example.com`, and Douze has to be allowed to reach
  that second address before it can do anything there. Say no and the actions are still recorded;
  they just won't run.
- **A tool says it is degraded.** The site changed. Douze reports the action as broken instead of
  quietly returning the wrong thing. Record the site again to fix it.
- **The assistant says Douze is offline.** Chrome shuts the extension's background worker down when
  it is idle and wakes it on its own; a call waits about 40 seconds for that. Beyond that, Chrome is
  closed. Open it.
- **You want it to stop.** Press **Stop sharing** on the connect page *first*, then remove the
  extension — and in that order. Removing it takes everything Douze stored in this browser with it:
  recordings, skills, example answers, the record of what your assistants ran. Three things do not
  go with it. A link you never stopped sharing leaves the relay holding your tool names,
  descriptions and schemas until it notices the extension is gone and drops the endpoint, which is
  about an hour — stopping first ends it immediately. `~/.douze/bridge.json` stays on disk if you
  ever paired a local app; it is one file and you can delete it by hand. And whatever an AI
  provider has already stored is under their retention policy, not ours — uninstalling Douze does
  not reach it. If you only want to stop *some* of it, the Douze data page deletes recordings and
  skills one at a time, and the connect page unpairs a local app.

---

# For developers

Everything below is about building and extending Douze, not using it.

## Architecture

```
  ChatGPT / claude.ai / Dust ──https──▶ relay ──┐
                                                ├──ws──▶ EXTENSION ──▶ your signed-in tabs
  Claude Code / Cursor / Desktop ──stdio──▶ bridge ──┘   (recipes, storage, inference,
                                                          review page, guards, audit)
```

The extension is the single source of truth and the only thing a consumer installs. The relay and
the bridge are two **stateless transports**: neither holds recipes, storage, inference or policy,
and both speak the same attachment protocol, so the extension has one implementation and does not
care which is on the far side. If a pipe grows state, this design has failed.

**The extension always dials; it can never listen**, and neither pipe can wake it. `chrome.alarms`
is the resurrection mechanism, and its 30-second floor is why both hosts hold an inbound call for
40 seconds before reporting the browser as gone.

**The host owns MCP sessions.** `initialize` and `tools/list` are answered by the relay or the
bridge from the surface the extension last pushed, so a connector added while Chrome is closed
still lists its tools instead of looking broken; only `tools/call` needs the browser awake. The
extension tracks no session state, because an MV3 service worker Chrome can evict cannot hold any.

### Trust

Trust is a property of the attachment, decided by the extension from **what it dialled**, and never
read off a frame. A `tool.call` carries the host's own `trust` claim and `attach.ts` deliberately
drops it: a relay operator or anyone holding a stolen URL can put whatever they like in it. A
loopback bridge the user paired is `local`; everything else is `remote`.

| | `remote` (relay) | `local` (bridge) |
|---|---|---|
| read tools | always | always |
| write tools | on by default per attachment, revocable | always |
| destructive tools | never, no setting restores them | allowed, `confirm: true` required |
| result secret gate | enforced, per-tool `expose` to exempt | enforced, per-tool `expose` to exempt |

It is enforced twice, and both halves are required: `attachedSurface` filters at push time so a
hosted client never sees a tool that would always be refused, and `checkPolicy` refuses at call time
whatever was pushed, because a host that lies about what it sent must not get through. Filtering
alone is a UI courtesy, not a control. Both live in `packages/extension/src/guards.ts` and nowhere
else.

### Storage

Captures — sessions, exchanges ordered by `(session_id, position)`, annotation spans — are in
IndexedDB (`packages/extension/src/store.ts`), which is why the manifest needs `unlimitedStorage`.
Recipes and fixtures are in `chrome.storage.local` under `recipe:` and `fixture:` prefixes, and
`chrome.storage.onChanged` is the hot-reload signal that replaces the daemon's file watcher.

`CaptureStore.appendExchange` is **the only write path for an exchange**. It re-applies redaction
and refuses anything `findSurvivingSecrets` still recognises. The gate is there rather than upstream
because HAR import never passes through capture-time redaction at all, and any future ingest will
have the same hole; `db` is private and no object-store access is exported, so from outside that
file there is no way to persist an exchange that skipped it.

### Redaction

Two rules decide what may be written, and both run at every persistence boundary:

1. A **key** on the credential list — `authorization`, `cookie`, `password`, `api_key`, and the
   rest — has its value replaced.
2. A **value that looks like a credential** whatever it is called — a JWT, a `sk_`/`pk_`/`rk_`
   prefixed key, a bearer prefix, a long high-entropy run — has its value replaced too.

The second rule is not optional politeness. A developer console returns its own API keys under
names like `publishableKey`, which no key list will ever contain; without it those values reach a
write gate that refuses the whole exchange, and recording such a site silently retains nothing.
Detection and removal share one test, so the gate and the redactor cannot disagree.

The placeholder keeps the original type and length (`«redacted:string:28»`), so schema inference
still sees a string of the right shape while the value itself is gone.

Redaction protects what Douze *stores*. A live tool result is not a fixture — it is whatever the
target returned a moment ago — so `gateResult` is a separate, last check before a result leaves the
browser at all.

### The four properties

1. **Discovery is passive.** The user uses the app normally; Douze watches. Nobody reads a network
   tab.
2. **Authentication is not a feature.** Requests execute inside the signed-in browser, so whatever
   auth the site uses already works — cookies, httpOnly, bearer tokens, CSRF, rotation. Douze
   stores no credential.
3. **Installation happens once.** Connect a client one time. Every recipe recorded afterwards
   appears automatically, with no rebuild and no reconnect.
4. **A broken tool fails loudly.** A tool whose stored fixture is missing is marked degraded: it
   says so in the description your assistant reads, and refuses before it issues a request, rather
   than quietly returning the wrong shape.

   What Douze does **not** do is notice a site changed on its own. Scheduled fixture replay and
   drift classification — the `douze doctor` run — were built for the daemon and deleted with it in
   WO-015; nothing has replaced them. When a site changes under a recipe, the tool keeps calling the
   old endpoint until you notice and record the site again.

## Packages

| Package | What it is |
|---|---|
| `packages/shared` | Recipe schema, capture types, execution protocol, redaction |
| `packages/extension` | **The product.** Chrome MV3: capture, storage, recipes, review, guards, execution |
| `packages/studio` | Inference and deterministic descriptions — a library the extension bundles (`@douze/studio/browser`) |
| `packages/mcp-host` | MCP termination plus the attachment protocol, shared by both pipes |
| `packages/relay` | The self-hostable relay: HTTPS/WSS transport and multi-tenant auth |
| `packages/bridge` | The local pipe: stdio MCP ↔ loopback WS, plus pairing |

`packages/relay/README.md` and `packages/bridge/README.md` document each pipe in full — the HTTP
API, the session rules, the wake grace, the pairing threat model, and what the logs may carry.

## Recipe format

The artifact is the **recipe**: versioned YAML describing one target's tools — endpoint, schema,
auth source, side effects, fixtures. You review it, hand-edit it, export it, diff it. It is data,
not code, and the extension stores the YAML source itself, so an export round-trips byte-identically
with your comments and key order intact.

```yaml
version: 1
name: orders                    # the tool namespace: orders_list_orders
enabled: true
target:
  base_url: https://app.example.com
auth:
  mode: browser_relay
  credential_source:
    - kind: cookie              # the browser attaches it; nothing is stored
tools:
  - name: list_orders
    description: Lists every order. Returns id, item, and status. Use when asked what orders exist.
    side_effect: read           # read | write | destructive
    confidence: 0.9
    observations: 3
    approved: true              # unapproved tools are never exposed
    fixtures: [list_orders.json]
    request:
      method: GET
      path: /api/orders         # `/api/orders/{orderId}` for templated endpoints
    response:
      primary_payload_path: $.data.orders
```

Constraints the schema enforces on load: no credential value may appear anywhere in the document except an `auth.credential_source` entry of `kind: literal`, which exists to carry a token the site hardcodes,
tool names are unique within a recipe, every approved tool references at least one fixture, and an
approved `destructive` tool must require a `confirm` parameter. A recipe that fails to parse never
reaches storage, and the last good version keeps serving.

Tools are **interpreted from recipes, not compiled into packages**. A `surface.push` on every recipe
change becomes `notifications/tools/list_changed` on the host, so an approval or an edited
description reaches a running session in seconds.

**Recipes in `~/.douze` from the daemon era.** The extension's importer takes exactly the layout the
daemon wrote — `recipes/<name>.yaml` alongside `fixtures/<recipe>/<tool>.json` — so a whole
`~/.douze` directory is a valid import set. It is an all-or-nothing write: any parse error or name
collision and nothing is stored. The file picker for it is on the Douze data page, alongside the
export it round-trips with, HAR import, and the controls that delete a recording or a skill set.
Nothing reads `~/.douze` on its own any more, and the only file still written there is the bridge's
pairing credential.

## Development

Node 22+, pnpm.

```sh
pnpm install
pnpm build                                  # all packages, including the extension
pnpm typecheck                              # tsc --noEmit, every package
pnpm lint                                   # oxlint over packages, e2e, fixtures
pnpm test                                   # unit tests, every package
pnpm release:local                          # build + zip ./douze-extension.zip
```

Working on the extension, point Chrome's **Load unpacked** straight at
`packages/extension/dist`.

```sh
pnpm exec tsx fixtures/server.ts            # the fixture dashboard on 127.0.0.1:4180

DOUZE_TEST_ORIGIN=http://127.0.0.1:4180 \
  pnpm --filter @douze/extension build      # bakes the fixture origin into host_permissions
pnpm --filter @douze/extension smoke        # boots the built extension in Helium and records
pnpm e2e                                    # Playwright, drives Helium with the unpacked build

pnpm --filter @douze/studio eval            # agent tool-selection accuracy on the reference recipe
```

The browser tests drive [Helium](https://helium.computer) with the unpacked extension. They cannot
run headless — MV3 service workers do not start under old headless — and they pin the fixture app to
port 4180, because a test build has to bake that origin into `host_permissions`:
`chrome.permissions.request` needs a user gesture Playwright cannot supply. The shipped build ships
`optional_host_permissions` and asks per target at record time.

## Running your own relay

`packages/relay` is the whole service: one Node 22 process, no database, no volume, nothing written
to disk, so a restart costs a reconnect and nothing else.

```sh
pnpm --filter @douze/relay build
node packages/relay/dist/index.js         # binds RELAY_HOST:RELAY_PORT, default 127.0.0.1:9787
```

Terminate TLS in front of it — it speaks plain HTTP and assumes anything reaching that port is
already inside the terminator. `packages/relay/README.md` has the HTTP API, the env vars, the
session rules, and what the logs are allowed to carry.

To verify a build yourself: `pnpm -r test` for the unit suites and `pnpm verify:e2e` for the
end-to-end ones, which drive a real browser against a fixture app — `e2e/README.md` explains what
each spec proves.

## Licence

MIT — see [LICENSE](LICENSE).
