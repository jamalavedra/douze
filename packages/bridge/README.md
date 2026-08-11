# @douze/bridge

The local pipe. It lets an MCP client running on your own machine — Claude Code, Cursor, VS Code,
Claude Desktop — reach the Douze browser extension with no cloud in the path.

It is **optional and developer-only.** Nobody needs it to use Douze: a consumer installs the
extension, connects it to the relay from a page in the browser, and never opens a terminal. This
exists for people who already have one.

```
  Claude Code ──stdio JSON-RPC──▶ bridge ──ws://127.0.0.1──◀ the extension dials in
```

Two ends, one `McpHost` (`@douze/mcp-host`) — the same MCP termination the relay uses, so there is
one implementation of MCP and one attachment protocol rather than two of each:

- **stdio**: newline-delimited JSON-RPC on stdin and stdout, which is what every local MCP client
  speaks. **stdout carries protocol and nothing else.** Every diagnostic — the pairing code
  included — goes to stderr, where your client's log picks it up.
- **a loopback WebSocket server** on `127.0.0.1` that the extension dials into. An extension cannot
  listen and it already knows how to dial, so the direction matches the relay's and the frames on
  it are identical.

It holds no state. No recipes, no storage, no inference, no policy — those live in the extension,
and that is the point of two pipes over one brain. The only thing it writes down is the pairing
credential below, which is about who may attach, not about what Douze knows.

## Trust: the difference from the relay

The extension decides trust from what it dialled, and this pipe is the reason the `local` column
exists:

| | `remote` (relay) | `local` (bridge) |
| --- | --- | --- |
| read tools | always | always |
| write tools | opt-in per attachment | always |
| destructive tools | never, no setting restores them | allowed, `confirm: true` required |
| result secret gate | enforced, `expose` list to exempt | enforced |

A relay operator or a leaked URL can forge a `confirm` argument; a process on your own machine
that you paired in person is a different claim, and destructive tools are reachable through this
pipe alone. `trust: 'local'` is stamped on every `tool.call` by the host at construction and is not
reachable from anything an MCP client sends.

## Running it

```jsonc
// .mcp.json, or your client's equivalent
{ "mcpServers": { "douze": { "command": "npx", "args": ["-y", "@douze/bridge"] } } }
```

The first run prints a pairing code to stderr:

```
douze-bridge: listening on ws://127.0.0.1:8912/ws
douze-bridge:   Pairing code: 7Q78-PEXT
```

Open the Douze extension, choose "Connect a local client", type it in. That is the whole flow, and
it happens once per machine — every later run reads the credential and prints no code.

## Pairing, and why it is not optional

**Loopback is not consent.** `127.0.0.1` proves only that the peer is on this machine, and every
process on this machine can dial it. Without a shared secret the first thing to connect would
inherit `local` trust, which includes destructive tools. So:

1. A bridge with no credential mints an 8-character code and prints it **to stderr**. stderr
   reaches the human through their client's log and reaches no socket.
2. The extension presents that code on `hello`. Nothing else attaches; every other socket is
   closed with 1008 before the host is ever told anything is there.
3. On success the bridge mints a 32-byte secret, hands it back alongside `welcome` for the
   extension to pin, and stores **only its sha256** in `~/.douze/bridge.json`, mode `0600`.
4. Every later run reads that file and never prompts again.

Ten failed attempts and the process refuses every connection until it is restarted — and only your
own MCP client restarts a bridge. That cap is what makes a short, typeable code safe on a port
anything can reach: brute-forcing 39 bits at ten guesses per process is not a thing that finishes.

### What an attacker on the same machine can and cannot do

Cannot, without ever having seen the code:

- attach and inherit `local` trust, which is what makes destructive tools reachable;
- reach the extension, your recipes, or any dashboard, through this pipe;
- read the code off the wire, because it never travels the wire in the pairing direction — the
  bridge prints it and only ever receives a candidate to compare;
- learn it by guessing, because of the ten-attempt cap;
- learn it from the credential file, which holds a sha256 of the secret and never the secret;
- learn it by timing, because both comparisons are `timingSafeEqual`.

Can:

- see that a bridge is listening, and that pairing has or has not happened (`connect` succeeds, and
  a refusal is distinguishable from a `welcome`);
- take the port, so the bridge walks to the next one in its range;
- occupy the ten attempts and so deny pairing until the client restarts the bridge.

**The residual, stated plainly: local malware running as you reads the file.** `~/.douze/bridge.json`
is `0600`, which stops other *users*, not other *code* running under your own account — the same
process can also read your browser profile, your SSH keys and your shell history. Anything that has
already achieved arbitrary code execution as you has better targets than this one; pairing defends
the boundary that is actually defensible, which is one local process against another that is not
running as you, and against every unprivileged listener that merely got to loopback first. A
`.mcpb`-style OS keychain would move the secret but not this line.

If you reinstall the extension and it no longer has the secret, delete `~/.douze/bridge.json` and
restart the bridge; it prints a fresh code. The refusal message says so.

## Ports

`8912–8916`, walked in order, taking the first that is free — **not** `PORT_RANGE` (8787–8791)
from `@douze/shared`. That range is douzed's, and it speaks a different protocol on it (capture,
not attachment), so a single range would have the extension meeting the wrong server until the
daemon goes away in phase 4. The walk itself is kept because a bridge is per MCP client rather than
per machine: Claude Code and Cursor open one each, so several are live at once and the extension
sweeps the range rather than assuming one.

## Lifecycle

- `hello` with a valid credential → `setAttached(true)`; a second one is a reconnecting worker and
  replaces the first.
- socket loss → `setAttached(false)`, which **fails in-flight calls at once** rather than leaving
  them on a 120-second timer. None is ever re-sent: a tool can be a write, and a silent retry of a
  write is worse than a failure a human decides about.
- `surface.push` replaces the cached surface and becomes `notifications/tools/list_changed` on
  stdout. Unlike the relay — whose HTTP transport has no server-initiated stream in v1 — stdio can
  carry that, so a bridge started before the browser lists nothing at first and corrects itself the
  moment the extension attaches.
- `ping`/`pong` every 20 seconds; two missed windows and the socket is terminated.
- a `tools/call` arriving with nothing attached is held for **40 seconds** before being answered as
  offline. Same number and same reason as the relay: an evicted MV3 service worker cannot be woken
  from outside and revives itself on a `chrome.alarms` floor of 30 seconds, so a shorter grace
  reports a browser that is merely asleep as one that is gone. It matters more here, because a
  bridge is spawned by the client and routinely starts before the browser has dialled in.
  `initialize` and `tools/list` never wait — they are answered from the cached surface.

## What the extension side must implement

- Dial `ws://127.0.0.1:<port>/ws` across `8912–8916`, attaching to each bridge that answers; one
  attachment client per bridge, since each is a separate MCP client's session.
- First frame `hello{extension_version, secret?, code?}` within 5 seconds — `secret` when this
  bridge's install has been paired before, `code` when the user has just typed one in. The
  credential rides *alongside* the attachment protocol's own fields, exactly as the endpoint token
  does in the relay's `hello`.
- Read `secret` off the **raw** `welcome` frame on a first pairing and pin it in extension storage;
  the `HostFrame` schema does not carry it, and parsing strictly would drop it.
- Treat a 1008 close as "not paired": prompt for a code rather than retrying the same credential.
- Derive `trust` from what it dialled — a `ws://127.0.0.1` bridge it paired is `local` — and never
  from anything a frame claims.
- Everything else is the attachment protocol it already speaks to the relay: `pong`,
  `surface.push` on connect and on every recipe change, `tool.result{id, result | error}`.

## Building

`pnpm --filter @douze/bridge build` emits one file, `dist/index.js`, with `ws`, the host and the
shared schemas bundled in and a shebang on top — which is what `npx` fetches, and what an MCP
client spawns without depending on a `node_modules` tree resolving from whatever cwd it chose.
