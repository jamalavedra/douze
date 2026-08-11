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
{ "mcpServers": { "douze": { "command": "node", "args": ["/absolute/path/to/douze/packages/bridge/dist/index.js"] } } }
```

The first run prints a pairing code to stderr:

```
douze-bridge: listening on ws://127.0.0.1:8912/ws
douze-bridge:   Pairing code: 7Q78-PEXT
```

Open the Douze extension, choose "Connect a local client", type it in. That is the whole flow, and
it happens once per machine — every later run reads the credential and prints no code.

## Pairing, and why it is not optional

**Loopback is not consent, and it is not identity either.** `127.0.0.1` proves only that the peer
is on this machine. Binding a loopback port needs no privilege, so any process running as any local
user can take 8913 and wait for the extension's next 30-second alarm — and the extension hands
`local` trust, destructive tools included, to whatever is on the far side of that socket. So
neither end tells the other anything until the other has **proved** it holds the credential.

### The handshake

One implementation, in `@douze/shared` (`bridge-handshake.ts`), imported by both ends so they
cannot drift into disagreeing about what proves what.

```
extension → hello             { extension_version, nonce: Ne }
bridge    → bridge.challenge  { nonce: Nb, salt?, proof: P(bridge) }
extension → bridge.proof      { proof: P(extension) }       only if P(bridge) verified
bridge    → welcome           { heartbeat_ms, secret? }     only if P(extension) verified
```

`P(role) = HMAC-SHA256(K, "douze-bridge-v1|<role>|<port>|<Ne>|<Nb>|<salt>")`, hex, compared in
constant time on both ends. `hello` and `bridge.proof` and `bridge.challenge` are the transport's
own frames and are deliberately not in the `HostFrame`/`ExtensionFrame` union, exactly as the
relay's endpoint token is not.

`K` is never on the wire, in either direction:

- **first pairing**: `K = PBKDF2-SHA256(code, "douze-bridge-v1|pairing|<salt>", 600 000 rounds)` —
  the iteration count OWASP's Password Storage Cheat Sheet gives for PBKDF2-HMAC-SHA256. The bridge
  mints an 8-character code and prints it **to stderr**, which reaches the human through their
  client's log and reaches no socket. The user types it into the extension. Nothing sends it. The
  **salt is 32 random bytes minted per bridge process** and travels on the challenge, unsalted-empty
  once paired; it is not a secret and it is not authenticated, which is safe — a rogue that sends
  its own only makes the extension derive a key the rogue still cannot prove anything with.
- **every attach after that**: `K = sha256(secret)`, which is exactly the 32 bytes in
  `~/.douze/bridge.json`. The 32-byte secret itself crosses the wire once — on the `welcome` that
  ends the pairing handshake, after the extension has proved it holds the code — and is written
  down nowhere on this side.

What each element of the transcript is for:

- **Both nonces**, 32 random bytes minted fresh per socket on both ends: a recorded transcript
  replays into a different `Nb` and a different `Ne` and verifies against neither end.
- **The role**, so a rogue cannot reflect the extension's own proof back at it.
- **The port**, which is the channel binding. Without it a rogue on 8913 could forward the whole
  exchange to a real bridge on 8912 and sit in the middle of it; with it, the challenge is bound to
  8912 while the extension is verifying against 8913, and the relay fails on both sides. One
  listener per port on loopback is the only binding two unauthenticated TCP connections have, and
  this uses it.

### What pays for a 39-bit code

The bridge answers a challenge to anything that says hello, so **one captured challenge is an
offline oracle**: `{port, Ne, Nb, salt, proof}` is everything needed to test a guess, at whatever
rate the attacker's hardware allows and with nothing on this side able to see it happening. No
attempt cap touches that, and any claim that it does is wrong. Three things do:

- **600 000 PBKDF2 rounds** per candidate, which is what a guess costs.
- **A salt minted per bridge process**, so that cost is paid per target. With a constant salt, one
  table over the whole 30^8 code space could be computed once — a few hundred GPU-days — and then
  turned any captured challenge into a recovered code in minutes, against every Douze install ever.
- **A ten-minute lifetime.** The code is minted at startup and dies unused; after that the bridge
  refuses to pair at all and says to restart it for a fresh one. That is the window the search has
  to finish inside, and it is also why the code being long-lived was the part that mattered: a
  bridge your editor spawned in the morning is otherwise still handing out oracles at six.

The code is also single-use — it is spent at the first pairing, and every later attach runs on the
32-byte credential instead, which is not guessable at all.

**Ten wrong proofs and the process refuses every connection until it is restarted.** That is the
bound on guessing done *at* the bridge, and only that. It is deliberately not spent on peers that
take a challenge and leave: those are refused per socket and reported, but not counted, because ten
abandoned sockets would otherwise be a way for any local process to lock you out of your own
pairing — a better attack than the one counting them would prevent.

Upgrades are rejected unless `Origin` is a `chrome-extension://` URL, before anything is counted as
an attempt. WebSocket connections are not subject to CORS, so without that check any page you
happen to visit could open `ws://127.0.0.1:8912/ws`, fingerprint whether Douze is running, and burn
the attempt cap until the bridge refuses your own extension.

### What an attacker on the same machine can and cannot do

Cannot, without holding the code or the credential:

- attach and inherit `local` trust, which is what makes destructive tools reachable;
- be told the tool surface, or anything else — an unproved peer is sent no `surface.push`, no
  `pong`, and gets no answer to a `tool.call`;
- reach the extension, your recipes, or any dashboard, through this pipe;
- read the code or the secret off the wire, because neither travels it: the extension sends a
  nonce, then an HMAC;
- pass off a secret of its own for the extension to pin, because a `welcome` from a peer that has
  not proved itself is ignored;
- replay a recorded handshake, because both nonces are fresh per socket;
- sit between a real extension and a real bridge, because the proof is bound to the port;
- guess it at the bridge, because ten wrong proofs end pairing for that process, or learn it by
  timing, because both ends compare digests in constant time;
- **unpair you.** A 1008 close from a bridge port is the word of a peer that has proved nothing, so
  the extension stops dialling that one port and writes nothing down. It used to overwrite the
  stored pairing, which made "bind a free port, close 1008" enough to unpair a working install for
  good.

Can:

- see that a bridge is listening, and that pairing has or has not happened;
- take the port, so the bridge walks to the next one in its range — and, by answering the
  extension's dial with a wrong proof, keep that port useless until the socket times out. It is
  told nothing and the extension's pairing is not turned off by it;
- collect challenges to search the code offline, which is what the section above is about;
- occupy the ten attempts and so deny pairing until the client restarts the bridge.

**The residual, stated plainly: local malware running as you reads the file.** `~/.douze/bridge.json`
is `0600`, which stops other *users*, not other *code* running under your own account — and what is
in it is the HMAC key, so reading it is enough to impersonate either end. The same process can also
read your browser profile, your SSH keys and your shell history. Anything that has already achieved
arbitrary code execution as you has better targets than this one; pairing defends the boundary that
is actually defensible, which is one local process against another that is not running as you, and
against every unprivileged listener that merely got to loopback first. A `.mcpb`-style OS keychain
would move the key but not this line.

If you reinstall the extension and it no longer has the secret, delete `~/.douze/bridge.json` and
restart the bridge; it prints a fresh code. The refusal message says so.

## Ports

`BRIDGE_PORT_RANGE` in `@douze/shared` — `8912–8916`, walked in order, taking the first that is
free. It lives there rather than in either end because both ends must agree on it: the bridge binds
the range and the extension sweeps it, and a constant declared twice is a constant that eventually
differs. The walk itself is kept because a bridge is per MCP client rather than per machine: Claude
Code and Cursor open one each, so several are live at once and the extension
sweeps the range rather than assuming one. The port is also part of the handshake transcript, which
is what stops one member of the range from relaying for another.

## Lifecycle

- a completed handshake → `setAttached(true)`; a second one is a reconnecting worker and replaces
  the first.
- socket loss → `setAttached(false)`, which **fails in-flight calls at once** rather than leaving
  them on a 120-second timer. None is ever re-sent: a tool can be a write, and a silent retry of a
  write is worse than a failure a human decides about.
- `surface.push` replaces the cached surface and becomes `notifications/tools/list_changed` on
  stdout. Unlike the relay — whose HTTP transport has no server-initiated stream in v1 — stdio can
  carry that, so a bridge started before the browser lists nothing at first and corrects itself the
  moment the extension attaches.
- `ping`/`pong` every 20 seconds; two missed windows and the socket is terminated.
- a handshake that is started and not finished — `hello` in, challenge out, then silence or a drop
  — is closed 1008 and **reported to stderr as a refused connection**, because from the user's side
  that is what a mistyped code looks like: the extension cannot verify this bridge's proof, so it
  stays quiet and there is nothing else to tell them with. Each phase of the handshake gets 5
  seconds of its own.
- a `tools/call` arriving with nothing attached is held for **40 seconds** before being answered as
  offline. Same number and same reason as the relay: an evicted MV3 service worker cannot be woken
  from outside and revives itself on a `chrome.alarms` floor of 30 seconds, so a shorter grace
  reports a browser that is merely asleep as one that is gone. It matters more here, because a
  bridge is spawned by the client and routinely starts before the browser has dialled in.
  `initialize` and `tools/list` never wait — they are answered from the cached surface.

## What the extension side must implement

- Dial `ws://127.0.0.1:<port>/ws` across `BRIDGE_PORT_RANGE`, attaching to each bridge that answers;
  one attachment client per bridge, since each is a separate MCP client's session. Chrome puts
  `Origin: chrome-extension://<id>` on the upgrade, which is what gets it past the check above.
- First frame `hello{extension_version, nonce}` within 5 seconds, carrying **no credential** — then
  the proof within 5 seconds of the challenge.
- Verify `bridge.challenge` before sending anything else, and stay silent on a mismatch rather than
  closing: a real bridge given the wrong code answers 1008 a moment later and says so on its stderr,
  and that is what tells the user to type it again. A rogue that answers badly must not be able to
  switch bridge pairing off from the outside.
- Derive the code's key against the challenge's `salt`, and cache that derivation per code: five
  ports are dialled on every alarm and 600 000 PBKDF2 rounds each time would be a browser tax.
- Treat a 1008 as **the word of a peer that proved nothing**. It may stop that port; it must not
  touch the stored pairing. Any process can bind a free port in the range and close 1008 on demand,
  and two clients running at once produce it in ordinary use — the bridge the user did not type a
  code for refuses on its own deadline seconds after the other paired.
- Read `secret` off the **raw** `welcome` frame on a first pairing and pin it in extension storage;
  the `HostFrame` schema does not carry it, and parsing strictly would drop it.
- Derive `trust` from what it dialled **and from what the far side proved** — a `ws://127.0.0.1`
  bridge whose proof verified is `local` — and never from anything a frame claims. Holding a secret
  is not the test; the peer proving it holds the same one is.
- Everything else is the attachment protocol it already speaks to the relay: `pong`,
  `surface.push` on connect and on every recipe change, `tool.result{id, result | error}`.

## Building

`pnpm --filter @douze/bridge build` emits one file, `dist/index.js`, with `ws`, the host and the
shared schemas bundled in and a shebang on top — which is what `npx` fetches, and what an MCP
client spawns without depending on a `node_modules` tree resolving from whatever cwd it chose.
