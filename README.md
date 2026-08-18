# Douze

Use a signed-in website once; expose the observed actions as MCP tools.

Douze is a Chrome extension. It records a tab's API traffic, infers tools, lets the user approve
them, and executes approved calls inside the same browser session.

## Demo

https://github.com/user-attachments/assets/175f9fd9-16fc-4bd7-aedf-ed9ee5f764a2

```text
hosted assistant ──HTTPS── relay ──┐
                                   ├──WebSocket── extension ── signed-in tab
local MCP client ──stdio── bridge ─┘
```

The extension owns capture, recipes, policy, execution, and audit data. The relay and bridge
terminate MCP and transport calls; neither executes a target request.

## Security boundary

- Douze records network traffic, not screen pixels. It retains inferable textual request and
  response bodies, capped at 2 MiB, in extension storage. Business data such as names, email
  addresses, and orders is not removed automatically.
- Recognized passwords, cookies, tokens, and credential-shaped values are redacted before capture
  or fixture persistence. Session cookies are attached by Chrome and are not copied into recipes.
- For tokens held in readable page state, recipes store where to read the current value, not the
  value. A fixed application token that cannot be re-read is retained per origin only after the
  review page displays it and the user approves it; exports omit these retained tokens.
- Hosted assistants send tool arguments and results through the relay. The relay operator and the
  AI provider can read or alter that data. The MCP URL is a credential: anyone holding it can call
  the tools it exposes.
- Live results are scanned before leaving the browser. Suspected credential values are masked;
  per-tool exemptions can be granted separately for hosted and local clients.

| Capability | Hosted assistant | Paired local client |
|---|---|---|
| Read | Always | Always |
| Write | Enabled when connected; can be disabled | Always |
| Destructive | Never | Requires `confirm: true` |

Pair only local clients you trust. Loopback alone does not establish trust; the bridge uses a
pairing handshake before the extension grants local permissions.

## Install from source

Requirements: Chrome 116+, Node 22+, and pnpm 10.

```sh
pnpm install
pnpm release:local
```

The build creates `douze-extension.zip` and `packages/extension/dist`.

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose `packages/extension/dist`.

There is currently no Chrome Web Store release.

## Record a site

1. Open the signed-in site and select **Watch this site** from the Douze popup.
2. Perform the actions Douze should learn, then select **Done**.
3. Review the inferred tools. All candidates start selected; deselect anything Douze must not
   expose.

The review groups tools as reads, writes, and destructive operations. Destructive tools remain
unavailable to hosted assistants even when approved.

Douze does not currently replay fixtures or detect API drift automatically. A tool is marked
degraded only when its stored fixture is missing.

## Connect an assistant

### Hosted clients

Open **Connect** in the extension, create a link, and add its MCP URL to the client. Use the
client's unauthenticated custom-MCP flow; the unguessable URL path authenticates access.

Client availability and permissions depend on the plan and workspace policy. Follow the current
client documentation instead of relying on UI paths copied here:

- [ChatGPT custom MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)
- [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Dust remote MCP servers](https://docs.dust.tt/docs/remote-mcp-server)

Some clients cache tool lists. Douze always exposes two stable tools as a fallback:

| Tool | Purpose |
|---|---|
| `douze_list_skills` | Return the currently available skills. |
| `douze_run_skill` | Run a skill returned by `douze_list_skills`. |

The same trust checks apply whether a skill is called directly or through `douze_run_skill`.

Use the extension's connect page to disable hosted writes, rotate the URL, stop sharing, manage
result exemptions, or pair a local client.

#### How long the link lasts

Paste the URL into your assistant once. It stays valid for as long as you keep using Douze — the
countdown below restarts every time your browser connects, which happens within about 30 seconds
of Chrome starting, on its own.

| Time with no browser connection | What happens | Your URL |
|---|---|---|
| 1 hour | The relay forgets your tools and closes open sessions. | Still valid. |
| 30 days | The relay deletes the link. | Dead — connect again and paste the new URL. |

So closing your laptop overnight, over a weekend or for a holiday costs nothing: reopen Chrome and
the tools come back by themselves. Only a month of never opening the browser — you uninstalled
Douze, moved to another machine, or stopped using it — retires the link.

**If your assistant says it has no tools**, that is the one-hour state: your browser is not
connected. Open Chrome on the computer where Douze is installed, leave it open for half a minute,
then start a new conversation. The link does not need replacing. Douze tells the assistant this
too, so a capable client should say it for you rather than claiming the tool does not exist.

The 30-day deletion is a safety net, not an inconvenience: the URL is the only credential — anyone
who copies it out of your assistant's settings has the same access you do, and it would otherwise
work forever. If a URL is ever exposed, do not wait for the clock; use **Get a new link**, which
invalidates the old one immediately.

### Local clients

Build the optional bridge:

```sh
pnpm --filter @douze/bridge build
```

Configure the MCP client to run the built file:

```jsonc
{
  "mcpServers": {
    "douze": {
      "command": "node",
      "args": ["/absolute/path/to/douze/packages/bridge/dist/index.js"]
    }
  }
}
```

The first run prints a pairing code to stderr. Enter it on the extension's connect page. See
[packages/bridge/README.md](packages/bridge/README.md) for the handshake and threat model.

## Stored data and removal

Captures live in IndexedDB. Recipes, fixtures, relay settings, approved fixed tokens, result
exemptions, and audit entries live in `chrome.storage.local`. A paired bridge also stores
`~/.douze/bridge.json`, containing a hash of its pairing secret.

The extension's data page can delete captures and recipes, import HAR files, and import or export
recipe sets. Imported tools remain unapproved until reviewed.

To revoke hosted access, select **Stop sharing** and check that it reports success *before*
uninstalling the extension. The token that authorises removal lives only in extension storage, so
uninstalling first leaves the relay endpoint in place, with no way for anyone but the relay
operator to remove it; it stops listing tools within the hour and is deleted after 30 days without
the extension. Uninstalling also leaves `~/.douze/bridge.json` and any data an AI provider has
already retained.

## Development

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:e2e
```

The E2E suite is macOS-only and requires `/Applications/Helium.app`; see
[e2e/README.md](e2e/README.md).

| Package | Responsibility |
|---|---|
| `packages/extension` | Chrome MV3 product: capture, review, storage, policy, and execution |
| `packages/shared` | Schemas, capture types, redaction, and handshake primitives |
| `packages/studio` | Inference and deterministic descriptions, bundled by the extension |
| `packages/mcp-host` | MCP termination and attachment protocol |
| `packages/relay` | Hosted HTTPS/WSS transport |
| `packages/bridge` | Local stdio/loopback transport |

Production extension builds request host permission when recording. Test builds may set
`DOUZE_TEST_ORIGIN` to bake fixture origins into `host_permissions`.

## Self-host the relay

The relay binds `127.0.0.1:9787` by default and serves plain HTTP behind your TLS terminator. The
[relay hosting guide](packages/relay/README.md#production-setup-systemd-and-caddy) covers DNS,
systemd, Caddy, persistent endpoint links, upgrades, recovery, and connecting the extension.

## License

MIT — see [LICENSE](LICENSE).
