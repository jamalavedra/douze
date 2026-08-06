# Douze

**Use a website for five minutes. Afterwards, Claude can use it too.**

You already have accounts on things — an order dashboard, a support inbox, a billing console, an
internal admin page. Claude can't touch any of them. Douze fixes that by watching you do the work
once.

Open the site you're signed into, click **Watch this site**, then do what you normally do: click
around, open a few orders, file a ticket. Click **Done**. Douze shows you a list of the actions it
saw — "list orders", "create ticket", "refund an order" — and you tick the ones Claude is allowed
to do. From then on you can type *"refund order 1042"* into Claude and it happens, in your account.

## What Douze does not do

This is the part worth reading carefully.

- **Nothing is scraped.** Douze doesn't read your screen or copy your data. It notices which
  buttons the site presses behind the scenes and remembers the shape of them.
- **Your password is never involved.** You never type it into Douze. Douze never asks for one.
- **No cookie or login is stored, copied, or sent anywhere.** Not to us, not to Claude, not to
  disk.
- **Requests run inside the browser you're already signed into.** That's why no login is needed:
  the site sees an ordinary request from an ordinary tab, exactly as if you'd clicked the button
  yourself. When you sign out, Claude loses access too.
- **Everything stays on your computer.** What Douze learns is a file in your home folder. There is
  no account, no server, and no upload.
- **Nothing runs without your say-so.** Actions are off until you turn them on, one at a time.
  Anything that deletes or refunds asks you to confirm every single time.

## Setting it up

Once, in about five minutes. No terminal, ever.

### 1. Download two files

Go to the [latest release](https://github.com/OWNER/douze/releases/latest) and download both:

- **`douze-extension.zip`** — double-click it to unzip. You get a folder called
  `douze-extension`. Put it somewhere you won't delete it, like your Documents folder.
- **`Douze.mcpb`**

> **Maintainer:** no release has been tagged yet, so that link 404s and the two files don't exist
> for anyone to download. Replace `OWNER` with the GitHub account this repo lives under, push a
> `v*` tag to build them, then delete this note.

### 2. Add the Chrome extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `douze-extension` folder you just unzipped.

The Douze icon appears in your toolbar. Pin it — you'll click it a lot.

Leave the folder where it is. Chrome reads it from that spot every time it starts, so moving or
deleting it turns Douze off.

### 3. Add Douze to Claude Desktop

Double-click **`Douze.mcpb`**. Claude Desktop opens, shows you what it does, and you click
**Install**.

There is nothing to fill in and nothing to copy. If a box asks you to type something, you have the
wrong file.

### 4. Teach it a site

1. Open a site you're signed into and go to the page you actually use.
2. Click the Douze icon, then **Watch this site**.
3. Use the site normally for a few minutes. Do the thing you'd want Claude to do — look up an
   order, file a ticket, whatever it is. Doing it twice or three times helps Douze get it right.
4. Click **Done**. A review page opens.
5. You'll see a plain-English list of what Douze saw. Turn on the ones you want Claude to be able
   to do, and leave the rest off.

Now ask Claude. The new abilities show up in a running conversation within a few seconds — you
don't have to restart anything.

## When something goes wrong

- **Claude says it can't reach Douze.** Quit Claude Desktop and open it again.
- **Nothing was recorded.** Douze only watches the tab you clicked **Watch this site** on. Make
  sure you're on that tab, and that you clicked **Done** rather than closing the window.
- **It worked last month and now it doesn't.** The site changed. Douze tells Claude the action is
  broken instead of quietly returning the wrong thing. Record the site again to fix it.
- **You want it to stop.** Turn actions off on the review page, or remove Douze from Claude
  Desktop's connector list. Nothing of yours is left behind.

---

# For developers

Everything below is about building and extending Douze, not using it.

## Architecture

```
  Chrome ext ──ws──▶ douzed ◀──http/loopback──┬── douze --mcp   (stdio, launched by Claude)
                     │                        └── douze jira create-issue   (shell)
                     └── review UI (http://127.0.0.1:8787/review/:sessionId)
```

`douzed` is the only always-on process. It binds a loopback port — 8787, or the next free one up to
8791 if something else already holds it — holds the extension's WebSocket, owns the recipe registry,
enforces every call guard, and serves the review UI. It is started by whichever client needs it
first — normally the MCP server that Claude Desktop launches — and outlives that client. The
extension probes the same range, so a busy 8787 (RStudio Server's default) doesn't strand it.

`/pair` is how the extension gets the install token without anyone copying it by hand. It answers
only a `chrome-extension://` origin — a web page can neither forge that header nor read the reply —
and it pins the first extension ID that pairs, refusing every other one after that. So the exposure
is the window before the first pairing: an extension with loopback host access that beats Douze to
it. Delete `~/.douze` to clear the pin, or set `DOUZE_EXTENSION_ID` to force one (the e2e suite does,
because an unpacked extension's ID changes with its path).

The artifact is the **recipe**: versioned YAML describing one target's tools — endpoint, schema,
auth source, side effects, fixtures. You review it, hand-edit it, commit it, diff it. It is data,
not code.

Tools are **interpreted from recipes, not compiled into packages**. The MCP process registers tools
dynamically at startup and re-registers them when a recipe changes, so an approved tool or an
edited description reaches a running Claude session in seconds.

### The four properties

1. **Discovery is passive.** The user uses the app normally; Douze watches. Nobody reads a network
   tab.
2. **Authentication is not a feature.** Requests execute inside the signed-in browser, so whatever
   auth the site uses already works — cookies, httpOnly, bearer tokens, CSRF, rotation. Douze
   stores no credential.
3. **Installation happens once.** Register Douze with a client one time. Every recipe recorded
   afterwards appears automatically, with no rebuild and no reconnect.
4. **It stays true.** Sites change. Douze replays stored fixtures, catches drift, and makes broken
   tools fail loudly instead of quietly returning the wrong shape.

## Packages

| Package | What it is |
|---|---|
| `packages/shared` | Recipe schema, capture types, the WebSocket protocol, and redaction |
| `packages/douzed` | The daemon: registry, hot reload, capture store, call guards, drift watcher, review UI |
| `packages/extension` | Chrome MV3 extension — capture and relay execution |
| `packages/studio` | Inference engine, description writer, package ejector |
| `packages/cli` | `douze` CLI and `douze --mcp`, built on [`incur`](https://github.com/wevm/incur) |

## Recipe format

```yaml
version: 1
name: orders                    # the tool namespace: orders_list_orders
enabled: true
target:
  base_url: https://app.example.com
auth:
  mode: browser_relay           # or `headless`, the explicitly degraded path
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

Constraints the schema enforces on load: no credential value may appear anywhere in the document,
tool names are unique within a recipe, every approved tool references at least one fixture, and an
approved `destructive` tool must require a `confirm` parameter.

## CLI reference

The consumer path uses none of these — the daemon starts itself and the review UI is a link. They
exist for development and maintenance.

```sh
douze start                          # start douzed in the background; reports one already running
douze stop                           # stop it
douze status                         # daemon, extension, and tool-surface state
douze sessions                       # list recorded capture sessions
douze import <file.har> --name jira  # import a HAR as a capture session

douze bundle                         # emit Douze.mcpb (see `pnpm bundle` below)
douze mcp add --agent claude-code    # register with Claude Code

douze doctor jira                    # replay fixtures against the live target, report drift
douze eject jira --out ./jira-tools  # emit a standalone incur package for one recipe
```

`DOUZE_HOME` (default `~/.douze`) holds recipes, fixtures, the capture database, the audit log, and
the install token.

## Development

Node 22+, pnpm.

```sh
pnpm install
pnpm build                                            # all packages, including the extension
pnpm test                                             # unit tests, all packages
pnpm typecheck
pnpm bundle                                           # build + emit ./Douze.mcpb

DOUZE_TEST_ORIGIN=http://127.0.0.1:4180 \
  pnpm --filter @douze/extension build                # e2e build grants the fixture origin
npx playwright test e2e                               # drives Helium with the unpacked extension
./node_modules/.bin/tsx e2e/metrics.mjs               # performance metrics + secret sweep
./node_modules/.bin/tsx e2e/eval/agent-selection.mjs  # real agent tool-selection accuracy
```

The e2e suite drives [Helium](https://helium.computer) with the unpacked extension via Playwright.
It cannot run headless — MV3 service workers do not start under old headless — and it pins the
fixture app to port 4180 because the e2e extension build bakes that origin into `host_permissions`.
The shipped build ships `optional_host_permissions` and grants per target at record time.

Every test roots `DOUZE_HOME` at a scratch directory, so nothing touches a real install.

Working on the extension itself, skip the zip and point Chrome's **Load unpacked** straight at
`packages/extension/dist`.

## Cutting a release

The two files the setup steps ask for are release assets. `.github/workflows/release.yml` builds
them on any pushed `v*` tag and attaches them to a GitHub Release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

| Asset | What it is |
|---|---|
| `douze-extension.zip` | `packages/extension/dist`, zipped. Unzips to a `douze-extension` folder that Chrome loads unpacked. |
| `Douze.mcpb` | The Claude Desktop connector bundle, from `pnpm bundle`. |

To produce both locally without the CI round trip:

```sh
pnpm release:local                    # pnpm build && pnpm bundle && pnpm pack:extension
```

Both land at the repo root and are gitignored. Release notes are generated from the commits since
the previous tag; the workflow needs no secrets beyond the automatic `GITHUB_TOKEN`.

## Live verification

```sh
node e2e/live/openfort.mjs            # read-only
node e2e/live/openfort.mjs --writes   # also exercises approved write tools
```

Records a real session against a real authenticated dashboard, infers tools, approves reads, and
calls one against the live account. It uses a persistent browser profile (`DOUZE_E2E_PROFILE`)
because signing in is a manual act that must survive between runs; the first run pauses and polls
until you have signed in.

See `TASKS.md` for the task and verification tracker.
