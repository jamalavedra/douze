RECON — Act on Authenticated Dashboards from Claude, Using Tools Discovered by Usage

Owner: Jaume Alavedra  
Author: Condor  
Date: 2026-08-05  
Status: Draft v3 (supersedes v2.1)  
Format: 8090 Software Factory — Product Overview, Feature Requirements, Blueprints, Work Orders  
Prior art: "Show HN: Reverse-engineering web apps into agent tools" (Frigade), 2026-07-09 — https://news.ycombinator.com/item?id=48847834

\================================================================  
PART 0 — THE DESIRED OUTCOME  
\================================================================

One sentence: you use a dashboard by hand for five minutes, and afterwards Claude Desktop can act on it.

Concretely. You open a dashboard you are already signed into — Jira, your Stripe account, an internal admin panel, a vendor console with no public API. You hit record in a Chrome extension and do the workflow once: create the issue, pull the report, flip the flag. You drop a note or two while you do it. You stop recording, spend two minutes approving what Recon inferred, and you are done.

From that point on, in Claude Desktop, you type "file a Jira issue for the login bug" and it happens — against your real account, with your real session, through the private API the dashboard uses itself. No API key was issued. No cookie was extracted. No headless browser opened. Nothing was scraped or clicked.

That is the whole product. Every requirement below exists to make that sentence true and keep it true.

The four properties that define success:

1\. Discovery is passive. You use the app normally; Recon watches. You never read a network tab or write a client.  
2\. Authentication is not a feature. Requests execute inside your signed-in browser, so whatever auth the site uses already works — cookies, httpOnly, bearer tokens, CSRF, rotation. Recon stores no credential.  
3\. Installation happens once. You register Recon with Claude Desktop and Claude Code a single time. Every recipe you record afterwards appears automatically, with no rebuild and no reconnect.  
4\. It stays true. Sites change. Recon replays stored fixtures, catches drift, and makes broken tools fail loudly instead of quietly returning the wrong shape.

Explicit non-goals: the in-app chat surface the prior art ships, agent orchestration, browser automation, and any hosted service.

\================================================================  
PART 1 — PRODUCT OVERVIEW  
\================================================================

1.1 BUSINESS PROBLEM

The dashboards worth automating rarely expose an API worth using. Their real capability surface lives in the private JSON endpoints the SPA calls on every click — fully documented, in effect, by the traffic a signed-in user already generates. That information is thrown away every session.

Rebuilding a client by hand means DevTools archaeology: copy-as-cURL, guess at schemas, hand-roll auth. A day per target, stale within weeks. Browser automation avoids the reverse engineering and replaces it with brittle selectors and seconds-per-action. Neither gets you to "Claude, file that issue."

The gap is a tool that watches, infers, and serves — turning five minutes of clicking into tools a chat client can call.

1.2 CURRENT STATE

\- DevTools archaeology: accurate, slow, decays.  
\- Playwright/Puppeteer: survives having no API, but slow, brittle, and needs a browser in the loop per action.  
\- OpenAPI-to-MCP converters: excellent when a spec exists. The whole problem here is that none does.  
\- Vendor MCP servers: a handful of large products, always narrower than the UI.  
\- Driving your own Chrome over CDP: dead as of Chrome 136, which refuses \`--remote-debugging-port\` against the default profile (see ADR-001).

None of them capture the artifact that is free and always current: the traffic.

1.3 PERSONAS

P1 — Solo builder, in a chat client (primary).  
Runs several personal projects across dashboards they own or hold accounts on. Wants Claude Desktop to read and act on those dashboards conversationally. Success: records a workflow once, then never thinks about plumbing again.

P2 — Solo builder, in a coding agent.  
Same person, in Claude Code, wiring dashboard reads into a task. Cares that the agent picks the right tool first try and that responses fit the context window.

P3 — Scripter.  
Wants a plain CLI for a repetitive chore, runnable from a shell or cron with no agent. Success: one command, JSON out, non-zero exit on failure.

All three are the same person on different days. Recon must not require a team, a server, or a second machine.

1.4 PRODUCT DESCRIPTION

Four processes, one artifact, two lifetimes.

The artifact is the recipe: versioned YAML describing one target's tools — endpoint, schema, auth source, side effects, fixtures. You review it, hand-edit it, commit it, diff it. It is data, not code.

Dev-time (runs while you are building a recipe, then quits):  
\- Chrome extension — records the target while you use it, signed in, in your own profile.  
\- recon studio — inference, description generation, and the review UI.

Runtime (small, always on):  
\- recond — the relay daemon and recipe registry. Holds the extension's WebSocket, enforces call guards, serves the recipe list. This is the only long-lived process.  
\- recon \--mcp / recon \<recipe\> \<tool\> — thin clients. The MCP process is launched by Claude Desktop or Claude Code and interprets recipes into live tools; the CLI is the same surface for a shell.

  Chrome ext ──ws──▶ recond ◀──http/loopback──┬── recon \--mcp   (stdio, launched by Claude)  
                                              └── recon jira create-issue   (shell)

       recon studio ──▶ recipes/\*.yaml ──▶ recond   (dev-time only)

Three decisions define the product.

First, tools are interpreted from recipes, not compiled into packages. recond loads every enabled recipe and the MCP process registers its tools dynamically at startup — incur's \`.command()\` is a runtime call, so the command tree is built in a loop. A recipe change reloads and fires \`notifications/tools/list\_changed\`, which Claude Code has handled correctly since v2.1.0. Consequence: you register Recon with a client once, ever, and every future recipe appears without a rebuild or a reconnect. Editing a description in review reaches the agent in seconds — and description quality is what drives the selection-accuracy metric, so that loop being fast matters more than any other.

Second, execution happens inside the browser. A tool call travels MCP process → recond → extension → same-origin \`fetch\` with \`credentials: 'include'\` from a tab on the target. The browser attaches the session; the app refreshes its own token. Nothing extracts a cookie, and auth support is identical across every target. The cost is that Chrome must be open and signed in — accepted for P1 and P2, and covered by an explicitly-degraded headless path for P3.

Third, codegen survives as an escape hatch, not the main road. \`recon eject\` emits a standalone incur package for one recipe when you want an artifact you own, ship, or run in CI. incur remains the framework Recon itself is built on: Zod schemas drive the CLI, \`--mcp\` exposes the same commands as MCP tools, \`skills add\` and \`--llms\` serve coding agents, and TOON output is roughly 40% cheaper than JSON.

1.5 SUCCESS METRICS

\- Record-to-callable-from-Claude-Desktop: under 15 minutes for a new target, median.  
\- Agent tool-selection accuracy: \>= 90% correct tool chosen on a held-out set of natural-language tasks per recipe. The metric that decides whether the product is useful.  
\- Description edit to live in a running client: under 30 seconds, with no reconnect.  
\- Client registrations required after first install: zero, regardless of how many recipes exist.  
\- Fixture replay pass rate on recipe load: \>= 95% of approved tools.  
\- Median tool-call overhead vs. a direct fetch: \< 150 ms through the relay.  
\- Median tool result after trimming: \< 2 KB.  
\- Recipes still passing \`doctor\` 30 days after creation: \>= 80%.

1.6 TECHNICAL REQUIREMENTS

\- TR-1. Chrome/Chromium MV3 extension, user's own profile, no second browser and no custom \`--user-data-dir\`.  
\- TR-2. TypeScript end to end, on incur. Node 22+ / Bun. Node ships inside Claude Desktop on macOS and Windows, so the MCP process needs no separate runtime there.  
\- TR-3. Local-first. Captures, recipes, and fixtures live on disk under the user's control. No hosted service.  
\- TR-4. Recipes are plain YAML, human-editable, git-friendly, versioned with a documented migration path.  
\- TR-5. \`recond\` is the only always-on process and must stay small enough to run unnoticed; inference, model calls, and the review UI live in \`recon studio\` and are never required at runtime.  
\- TR-6. Secrets are never written into recipes, fixtures, generated source, or logs.  
\- TR-7. macOS and Linux in v1; Windows fast-follow.

\================================================================  
PART 2 — FEATURE REQUIREMENTS  
\================================================================

\----------------------------------------------------------------  
FRD-1 — SESSION CAPTURE  
\----------------------------------------------------------------

\#\# Overview

Capture records what the target app does while you drive it by hand, in your normal signed-in Chrome profile, because the traffic worth capturing only exists behind a login. A recording is scoped to one named intent — "create and transition an issue" — so the resulting tools have a reason to exist rather than being a dump of every request the page made.

Capture is passive by design. You use the app the way you always do, optionally narrating; the work happens afterwards.

\#\# Terminology

Capture Session: a named recording bounded by explicit start and stop, scoped to one or more origins.  
Exchange: one request/response pair with headers, bodies, timing, and the UI action that preceded it.  
UI Provenance: the element, route, and user gesture immediately preceding an exchange.  
Annotation Span: a user-written note attached during recording, covering the exchanges captured since the previous note.  
MAIN world: the page's own JavaScript context, where an injected script sees \`fetch\` and \`XMLHttpRequest\` calls with their bodies.

\#\# Requirements

REQ-CAP-001: Scoped Session Recording  
As a solo builder, I want to record a named session limited to the app I am using, so that I capture one workflow instead of everything my browser does.  
\- AC-CAP-001.1: When the user starts a session from the extension popup, the system shall record only exchanges whose origin matches the active tab's origin or a user-added allowlist entry.  
\- AC-CAP-001.2: When a session is started, the system shall require a session name and shall reject an empty name.  
\- AC-CAP-001.3: When a session is active, the system shall display a persistent badge on the extension icon showing the captured exchange count.  
\- AC-CAP-001.4: When the user stops a session, the system shall persist it and shall report the exchange count retained after filtering.

REQ-CAP-002: Body-Level Exchange Capture  
As a solo builder, I want request and response bodies captured, so that schemas can be inferred rather than guessed.  
\- AC-CAP-002.1: When the page issues a \`fetch\` or \`XMLHttpRequest\` call during an active session, the system shall record method, full URL, request headers, request body, response status, response headers, and response body.  
\- AC-CAP-002.2: When a response body is not valid UTF-8 or exceeds 2 MB, the system shall record its content type and size and shall omit the body.  
\- AC-CAP-002.3: When body capture via the MAIN-world interceptor fails for a request that \`chrome.webRequest\` observed, the system shall record the exchange with headers only and shall mark it \`body\_missing\`.  
\- AC-CAP-002.4: When the user enables debugger-based capture for a session, the system shall attach \`chrome.debugger\` to the tab and capture exchanges the MAIN-world interceptor cannot see, including those issued by the page's service worker.

REQ-CAP-003: UI Provenance  
As a solo builder, I want to know which user action produced a request, so that tool descriptions describe intent rather than restating the URL.  
\- AC-CAP-003.1: When an exchange is recorded, the system shall attach the accessible name and role of the last interactive element the user activated within the preceding 2 seconds, when one exists.  
\- AC-CAP-003.2: When an exchange is recorded, the system shall attach the document title and route path at the time of the request.  
\- AC-CAP-003.3: When no user gesture preceded the request within the window, the system shall mark the exchange \`background\` and shall omit provenance rather than attaching a stale gesture.

REQ-CAP-004: Noise Filtering  
As a solo builder, I want analytics and asset traffic excluded, so that review is not buried in irrelevant requests.  
\- AC-CAP-004.1: When an exchange matches the bundled noise list (analytics, error reporting, session replay, ad, and telemetry hosts), the system shall exclude it.  
\- AC-CAP-004.2: When an exchange's response content type is not JSON, form-encoded, GraphQL, or plain text, the system shall exclude it.  
\- AC-CAP-004.3: When the user edits the noise list, the system shall apply the change to subsequent sessions and shall offer to re-filter existing sessions without re-recording.

REQ-CAP-005: Redaction Before Persistence  
As a solo builder, I want secrets stripped before anything is written to disk, so that a recipe or fixture is safe to commit.  
\- AC-CAP-005.1: When an exchange is persisted, the system shall replace values of headers matching the credential-header list (\`authorization\`, \`cookie\`, \`set-cookie\`, \`x-api-key\`, \`x-csrf-token\`, and user additions) with a stable placeholder.  
\- AC-CAP-005.2: When a request or response body contains a field whose key matches the secret-field list (\`password\`, \`token\`, \`secret\`, \`apiKey\`, \`refresh\_token\`, and user additions), the system shall replace its value with a placeholder.  
\- AC-CAP-005.3: When redaction replaces a value, the system shall retain the value's type and length so that schema inference is not degraded.  
\- AC-CAP-005.4: When the user views a captured exchange, the system shall display placeholders and shall never display the original value.

REQ-CAP-006: HAR Import  
As a solo builder, I want to import a HAR file, so that I can produce tools from a DevTools export without installing the extension.  
\- AC-CAP-006.1: When the user imports a HAR file, the system shall convert its entries into a Capture Session applying the same filtering and redaction as live capture.  
\- AC-CAP-006.2: When a HAR entry lacks a response body, the system shall mark the exchange \`body\_missing\` rather than rejecting the import.

REQ-CAP-007: Usage Annotation  
As a solo builder, I want to annotate what I am doing while I record, so that tools carry intent the system cannot infer from traffic alone.  
\- AC-CAP-007.1: When a session is active, the system shall let the user attach a free-text note from the extension popup and shall associate it with every exchange captured since the previous note.  
\- AC-CAP-007.2: When a note is attached, the system shall persist it as an Annotation Span with its start and end exchange positions.  
\- AC-CAP-007.3: When a candidate tool derives from exchanges covered by an Annotation Span, the system shall pass that note to description generation as higher-priority evidence than UI provenance.  
\- AC-CAP-007.4: When the user attaches no notes, the system shall still produce candidates, and annotation shall never be required to complete a session.  
\- AC-CAP-007.5: When an Annotation Span covers exchanges that inference splits across several candidates, the system shall attach the note to each of them.

\----------------------------------------------------------------  
FRD-2 — API INFERENCE  
\----------------------------------------------------------------

\#\# Overview

Inference turns a pile of exchanges into scored candidate tools: grouping requests into endpoint templates, deriving schemas from observed values, splitting GraphQL by operation, and writing names and descriptions a model can choose between. Everything it produces traces to at least one real exchange.

Description quality is the deliverable. A tool with a perfect schema and a vague description is a tool Claude never calls — and in a chat client there is no CLI to fall back on.

\#\# Terminology

Endpoint Template: a path with variable segments parameterized — \`/orders/1042\` and \`/orders/1043\` become \`/orders/{orderId}\`.  
Candidate Tool: an inferred, not-yet-approved operation.  
Confidence: a 0–1 score from observation count, schema stability, and side-effect certainty.  
Primary Payload Path: the JSONPath into the response holding the useful data, distinct from the envelope.

\#\# Requirements

REQ-INF-001: Endpoint Templating  
As a solo builder, I want requests that differ only by identifier collapsed into one tool, so that I get \`get\_order\` instead of forty tools.  
\- AC-INF-001.1: When two or more exchanges share a method and differ only in one path segment, the system shall emit a single Endpoint Template with that segment as a named parameter.  
\- AC-INF-001.2: When a variable segment's values appear as an \`id\`-like field in an observed response body, the system shall name the parameter after that field.  
\- AC-INF-001.3: When a variable segment cannot be named from evidence, the system shall name it from the preceding static segment in singular form.

REQ-INF-002: Schema Inference  
As a solo builder, I want typed inputs derived from observed traffic, so that Claude cannot construct an invalid request.  
\- AC-INF-002.1: When inferring a request schema, the system shall mark a field required only if it is present in every observation and optional otherwise.  
\- AC-INF-002.2: When a field's observed values are strings with fewer than 12 distinct values across at least 3 observations, the system shall emit an open enum.  
\- AC-INF-002.3: When a tool is inferred from a single observation, the system shall assign confidence \<= 0.4 and shall mark it \`sparse\`.  
\- AC-INF-002.4: When inference completes, the system shall emit each schema as JSON Schema convertible to Zod at load time without manual editing.

REQ-INF-003: Side-Effect Classification  
As a solo builder, I want writes distinguished from reads, so that approval and confirmation are stricter where it matters.  
\- AC-INF-003.1: When classifying a candidate, the system shall label GET and HEAD as \`read\` and POST, PUT, PATCH, and DELETE as \`write\`.  
\- AC-INF-003.2: When a candidate's path or GraphQL operation name matches a destructive pattern (\`delete\`, \`remove\`, \`purge\`, \`cancel\`, \`refund\`, \`revoke\`), the system shall label it \`destructive\`.  
\- AC-INF-003.3: When a candidate is labeled \`write\` or \`destructive\`, the system shall require individual approval and shall not permit bulk approval.

REQ-INF-004: GraphQL Operation Splitting  
As a solo builder, I want each GraphQL operation to become its own tool, so that a single \`/graphql\` endpoint does not collapse into one useless tool.  
\- AC-INF-004.1: When exchanges target a GraphQL endpoint, the system shall group them by operation name and shall emit one candidate per operation.  
\- AC-INF-004.2: When emitting a GraphQL candidate, the system shall derive the input schema from the observed \`variables\` object and shall store the operation document with the recipe.  
\- AC-INF-004.3: When an observed operation is anonymous, the system shall derive a name from its root field and shall mark it \`derived\_name\`.  
\- AC-INF-004.4: When a GraphQL response contains an \`errors\` array with HTTP 200, the system shall classify the exchange as failed and shall exclude it from schema inference.

REQ-INF-005: Response Trimming  
As a solo builder, I want responses trimmed to what matters, so that a tool result does not consume the chat context window.  
\- AC-INF-005.1: When inferring a response contract, the system shall identify a Primary Payload Path and shall default the tool to returning only that subtree.  
\- AC-INF-005.2: When a response is a paginated collection, the system shall expose page or cursor parameters and shall record the pagination style.  
\- AC-INF-005.3: When the untrimmed response is needed, the system shall expose a \`raw\` parameter that returns the full body.

REQ-INF-006: Naming and Description Generation  
As a solo builder, I want names and descriptions written for tool selection, so that Claude picks correctly without trial and error.  
\- AC-INF-006.1: When naming a candidate, the system shall emit a verb-object name in snake\_case derived from method, path, annotation, and UI provenance.  
\- AC-INF-006.2: When describing a candidate, the system shall state what the tool does, what it returns, and when to use it, in at most 3 sentences.  
\- AC-INF-006.3: When two candidates would receive the same name within a recipe, the system shall disambiguate from distinguishing parameters.  
\- AC-INF-006.4: When generating descriptions, the system shall send only redacted payloads to the language model.  
\- AC-INF-006.5: When the user configures a local model endpoint, the system shall use it instead of a remote provider.

\----------------------------------------------------------------  
FRD-3 — RECIPE AND REVIEW  
\----------------------------------------------------------------

\#\# Overview

The recipe is the artifact you own and the unit the runtime loads. Review is where a candidate becomes a tool: you read the inferred name, description, and schema next to a real sample exchange, fix what is wrong, and approve. Nothing reaches a client unapproved.

Because the runtime interprets recipes rather than compiling them, an edit here is visible to a running Claude session within seconds. That makes review the primary tuning surface for selection accuracy, not a one-time gate.

\#\# Terminology

Recipe: versioned YAML describing one target's tools, auth source, and fixtures.  
Fixture: a redacted request/response pair stored with the recipe, used for load-time validation and drift replay.  
Promotion: approving a candidate so the runtime exposes it.

\#\# Requirements

REQ-REC-001: Recipe Format  
As a solo builder, I want recipes to be readable YAML, so that I can review a change in a diff.  
\- AC-REC-001.1: When a recipe is written, the system shall emit YAML containing recipe name, schema version, target base URL, auth source descriptor, an \`enabled\` flag, and one entry per tool with name, description, side effect, confidence, observation count, request contract, response contract, and fixture references.  
\- AC-REC-001.2: When a recipe is written, the system shall include no credential value, only a descriptor of where the credential originates.  
\- AC-REC-001.3: When the recipe schema version changes, the system shall migrate older recipes in place and shall report every field it altered.  
\- AC-REC-001.4: When a recipe fails schema validation on load, the runtime shall skip that recipe, shall serve all others, and shall report the failure by recipe name.

REQ-REC-002: Review and Promotion  
As a solo builder, I want to approve tools individually with real evidence in front of me, so that I do not expose a tool I do not understand.  
\- AC-REC-002.1: When the user opens review, the system shall list candidates with name, description, side-effect label, confidence, observation count, annotation, UI provenance, and a redacted sample exchange.  
\- AC-REC-002.2: When the user edits a name, description, or schema field, the system shall write the change to the recipe and shall mark the field \`user\_edited\`.  
\- AC-REC-002.3: When the user bulk-approves, the system shall apply approval only to \`read\` candidates.  
\- AC-REC-002.4: When the user approves a \`destructive\` candidate, the system shall add a required \`confirm\` parameter to the exposed tool.  
\- AC-REC-002.5: When a candidate is unapproved, the runtime shall not expose it.

REQ-REC-003: Non-Destructive Regeneration  
As a solo builder, I want my edits preserved across recaptures, so that improving a recipe is not wasted work.  
\- AC-REC-003.1: When re-inference produces a value for a field marked \`user\_edited\`, the system shall keep the user value and shall record the inferred alternative as a suggestion.  
\- AC-REC-003.2: When re-inference finds a tool absent from the new capture, the system shall retain it and shall mark it \`unverified\` with the date last observed.  
\- AC-REC-003.3: When re-inference changes a schema in a way that invalidates a stored fixture, the system shall report the conflict and shall not overwrite the recipe until the user resolves it.

REQ-REC-004: Fixtures  
As a solo builder, I want real exchanges stored with the recipe, so that load-time checks and drift runs have something to compare against.  
\- AC-REC-004.1: When a candidate is approved, the system shall store at least one redacted fixture for it.  
\- AC-REC-004.2: When a fixture is written, the system shall re-run redaction and shall fail the write if any credential-shaped value survives.

\----------------------------------------------------------------  
FRD-4 — TOOL RUNTIME  
\----------------------------------------------------------------

\#\# Overview

The runtime is what makes the desired outcome hold after the first recipe. It loads every enabled recipe, builds a live tool surface from them, and serves that surface to Claude Desktop, Claude Code, and the shell from one process family. No build step stands between approving a tool and calling it.

This is the feature that turns "I recorded a target" into "Claude can use it" without a single extra install.

\#\# Terminology

Runtime: \`recond\` plus the thin \`recon \--mcp\` and \`recon \<recipe\> \<tool\>\` clients.  
Tool Surface: the set of tools exposed to a client at a point in time, across all enabled recipes.  
Namespaced Name: \`\<recipe\>\_\<tool\>\` in MCP, \`recon \<recipe\> \<tool\>\` in the CLI.  
Hot Reload: rebuilding the Tool Surface after a recipe changes, without restarting the client.

\#\# Requirements

REQ-RUN-001: Recipe Interpretation  
As a solo builder, I want tools built from recipes at load time, so that approving a tool is the last step before using it.  
\- AC-RUN-001.1: When the runtime starts, it shall load every recipe marked \`enabled\` and shall register one command per approved tool, converting each stored JSON Schema to a Zod schema at load time.  
\- AC-RUN-001.2: When the runtime registers a tool, it shall expose it in the CLI as \`recon \<recipe\> \<tool\>\` and over MCP as \`\<recipe\>\_\<tool\>\`.  
\- AC-RUN-001.3: When two recipes define the same tool name, the namespace shall keep them distinct and the runtime shall not rename either.  
\- AC-RUN-001.4: When a recipe is marked \`enabled: false\`, the runtime shall load it for \`doctor\` purposes but shall not expose its tools.  
\- AC-RUN-001.5: When a tool's fixtures fail load-time schema validation, the runtime shall expose the tool as degraded rather than omitting it silently, and shall name the failing fixture.

REQ-RUN-002: Hot Reload  
As a solo builder, I want description and schema edits to reach a running client without a restart, so that tuning selection accuracy is a fast loop.  
\- AC-RUN-002.1: When a recipe file changes on disk, the runtime shall reload it within 5 seconds and shall rebuild the Tool Surface.  
\- AC-RUN-002.2: When the Tool Surface changes and a client has declared the \`listChanged\` capability, the MCP process shall send \`notifications/tools/list\_changed\`.  
\- AC-RUN-002.3: When a reload fails validation, the runtime shall keep serving the previously loaded version of that recipe and shall report the error without disturbing other recipes.  
\- AC-RUN-002.4: When a client does not support \`listChanged\`, the runtime shall still serve the updated surface on the next client restart and shall document that limitation.

REQ-RUN-003: Single Long-Lived Process  
As a solo builder, I want one small always-on process, so that Recon is not something I have to think about.  
\- AC-RUN-003.1: When \`recond\` is running, it shall be the only Recon process required for tool calls, and neither inference, description generation, nor the review UI shall be loaded in it.  
\- AC-RUN-003.2: When a second \`recond\` is started, it shall detect the running instance and shall exit with a message rather than binding a second port.  
\- AC-RUN-003.3: When \`recon \--mcp\` or the CLI starts and \`recond\` is not running, it shall start it automatically and shall proceed once the relay is reachable.  
\- AC-RUN-003.4: When \`recond\` restarts, connected clients shall recover on their next call without user action.

REQ-RUN-004: Result Shaping  
As a solo builder, I want tool results small and legible, so that chat context is not consumed by response envelopes.  
\- AC-RUN-004.1: When returning a tool result, the runtime shall apply the recipe's Primary Payload Path unless the call sets \`raw\`.  
\- AC-RUN-004.2: When a trimmed result exceeds 32 KB, the runtime shall truncate it, shall state that it truncated, and shall report the untrimmed size.  
\- AC-RUN-004.3: When serving the CLI, the runtime shall default to TOON output and shall support \`--format json|yaml|md\`.

\----------------------------------------------------------------  
FRD-5 — CONNECTOR INSTALLATION  
\----------------------------------------------------------------

\#\# Overview

Installation is a one-time act, and it is the moment the product either feels finished or feels like a toolchain. Claude Desktop installs a double-clickable bundle; Claude Code takes a single \`mcp add\`. Neither is repeated when you record a new target.

Claude Desktop is the primary surface, because it is where the desired outcome in Part 0 is written.

\#\# Terminology

MCPB Bundle: a \`.mcpb\` zip containing a \`manifest.json\` and the local MCP server, installable by double-click in Claude Desktop.  
User Config: the manifest section from which Claude Desktop generates a settings form.

\#\# Requirements

REQ-CON-001: Claude Desktop Installation  
As a solo builder, I want to install Recon into Claude Desktop by double-clicking a file, so that setup requires no JSON editing.  
\- AC-CON-001.1: When the user runs \`recon bundle\`, the system shall emit a \`.mcpb\` file containing a \`manifest.json\` and the MCP server entry point.  
\- AC-CON-001.2: When the bundle is installed in Claude Desktop, the manifest's \`user\_config\` shall present the relay URL and install token as form fields.  
\- AC-CON-001.3: When the bundle runs on macOS or Windows, it shall use the Node runtime shipped with Claude Desktop and shall require no separate runtime installation.  
\- AC-CON-001.4: When a new recipe is approved after installation, its tools shall appear in Claude Desktop without reinstalling or rebuilding the bundle.

REQ-CON-002: Claude Code Installation  
As a solo builder, I want one command to register Recon with Claude Code, so that the coding agent shares the same tool surface.  
\- AC-CON-002.1: When the user runs \`recon mcp add \--agent claude-code\`, the system shall write a stdio server entry invoking \`recon \--mcp\` and shall report the scope it wrote to.  
\- AC-CON-002.2: When registration completes, \`claude mcp list\` shall report the server as connected.  
\- AC-CON-002.3: When deriving the server name, the system shall reject names reserved by Claude Code (\`workspace\`, \`claude-in-chrome\`, \`computer-use\`, \`Claude Preview\`, \`Claude Browser\`) and shall suffix instead.  
\- AC-CON-002.4: When the user runs \`recon skills add\`, the system shall install skill files describing the enabled recipes' tools with worked examples drawn from fixtures.

REQ-CON-003: Long-Call Survival  
As a solo builder, I want slow calls to complete rather than time out, so that a relayed request waiting on the browser is not aborted.  
\- AC-CON-003.1: When a relayed call has not returned within 60 seconds, the MCP process shall emit a progress notification and shall repeat it every 60 seconds until the call completes.  
\- AC-CON-003.2: When a call exceeds the configured ceiling, the runtime shall cancel it and shall return a structured timeout naming the tool and elapsed time.

REQ-CON-004: Legible Failure in a Chat Client  
As a solo builder, I want failures explained inside the chat, so that I can fix them without a terminal.  
\- AC-CON-004.1: When \`recond\` is unreachable, a tool call shall return an error stating that the Recon relay is not running and how to start it.  
\- AC-CON-004.2: When the Chrome extension is not connected, a tool call shall return an error naming the disconnected extension and the target.  
\- AC-CON-004.3: When the target session has expired, a tool call shall return an error naming the target and instructing the user to sign in.  
\- AC-CON-004.4: When any of these errors is returned, the runtime shall not retry and shall not substitute a headless attempt.

\----------------------------------------------------------------  
FRD-6 — AUTHENTICATED EXECUTION  
\----------------------------------------------------------------

\#\# Overview

Every target is behind a login, so execution decides whether the product works at all. Recon's answer is to not handle credentials: a tool call is relayed to the extension and issued as a same-origin \`fetch\` from a tab on the target, carrying the session you already have. httpOnly cookies work because the browser attaches them; token refresh works because the app refreshes itself.

The cost is that Chrome must be running and signed in. For cron, a headless mode exists — explicitly the degraded path.

\#\# Terminology

Relay: the path MCP process or CLI → \`recond\` → extension → target origin → back.  
Executor Tab: the tab, visible or offscreen, on the target origin from which relayed requests are issued.  
Headless Mode: direct execution from \`recond\` using an exported session, without the browser.

\#\# Requirements

REQ-EXE-001: Browser Relay Execution  
As a solo builder, I want tool calls to run inside my signed-in browser, so that authentication requires nothing beyond staying logged in.  
\- AC-EXE-001.1: When a tool is invoked, the calling process shall send a request descriptor to \`recond\` over loopback with the install token and shall not issue the target request itself.  
\- AC-EXE-001.2: When \`recond\` receives a descriptor, it shall forward it to the extension over the persistent WebSocket, and the extension shall issue the request from an Executor Tab on the target origin with credentials included.  
\- AC-EXE-001.3: When the recipe records that the app carries its credential in page state rather than a cookie, the extension shall read that value from the page context exactly as the app does and shall attach it to the relayed request.  
\- AC-EXE-001.4: When no Executor Tab exists for the target origin, the system shall open an offscreen tab on that origin before issuing the request.  
\- AC-EXE-001.5: When the target responds, the system shall return status, headers, and body to the caller for shaping under REQ-RUN-004.

REQ-EXE-002: Session Expiry Handling  
As a solo builder, I want a clear signal when I am logged out, so that I fix the real problem instead of debugging a schema.  
\- AC-EXE-002.1: When a relayed request returns 401 or 403, or redirects to a login route, the system shall classify the failure as \`session\_expired\`.  
\- AC-EXE-002.2: When a failure is classified \`session\_expired\`, the system shall surface it per AC-CON-004.3 and shall not retry.  
\- AC-EXE-002.3: When the extension detects an expired session for a target with an open Executor Tab, it shall surface a browser notification linking to that target's login page.

REQ-EXE-003: Call Safety  
As a solo builder, I want guardrails on exposed tools, so that an agent loop cannot hammer a target or fire a destructive call by accident.  
\- AC-EXE-003.1: When a recipe declares a rate limit, \`recond\` shall enforce it per tool and shall queue rather than drop excess calls.  
\- AC-EXE-003.2: When a tool marked \`destructive\` is invoked without \`confirm\` set, \`recond\` shall reject the call before any network request is issued.  
\- AC-EXE-003.3: When any tool is invoked, \`recond\` shall append a redacted audit entry recording tool name, parameters, status, and duration.  
\- AC-EXE-003.4: When a tool is marked degraded by drift, \`recond\` shall reject the call before any network request and shall name the detected change.

REQ-EXE-004: Headless Mode  
As a scripter, I want unattended execution, so that a recipe can run from cron.  
\- AC-EXE-004.1: When the user explicitly enables Headless Mode for a target, the system shall export that target's session into the OS keychain and shall record only a reference in configuration.  
\- AC-EXE-004.2: When executing in Headless Mode, \`recond\` shall issue requests directly and shall apply the recipe's declared refresh endpoint on 401 with a single retry.  
\- AC-EXE-004.3: When Headless Mode is active, every invocation shall emit a notice identifying it as the degraded execution path.  
\- AC-EXE-004.4: When a stored session fails to refresh, the system shall clear it from the keychain and shall report that browser relay is required to re-establish it.

\----------------------------------------------------------------  
FRD-7 — DRIFT DETECTION  
\----------------------------------------------------------------

\#\# Overview

Private APIs change without notice, and a tool that silently returns the wrong shape is worse than a tool that is missing — especially in a chat client, where a wrong answer looks exactly like a right one. Drift detection replays read-only fixtures against the live target, degrades affected tools loudly, and proposes a recipe patch.

\#\# Terminology

Doctor Run: a replay of a recipe's read-only fixtures against the live target.  
Degraded Tool: an approved tool whose contract no longer matches observed behavior.

\#\# Requirements

REQ-DRF-001: Fixture Replay  
As a solo builder, I want to know when a target changed, so that I find out before Claude does.  
\- AC-DRF-001.1: When a Doctor Run executes, the system shall replay only \`read\` fixtures and shall never replay \`write\` or \`destructive\` fixtures.  
\- AC-DRF-001.2: When a Doctor Run completes, the system shall report per tool one of \`ok\`, \`schema\_widened\`, \`breaking\`, \`session\_expired\`, or \`gone\`.  
\- AC-DRF-001.3: When a Doctor Run is scheduled, the system shall run it at the configured interval and shall skip silently if the browser relay is unavailable.

REQ-DRF-002: Degradation  
As a solo builder, I want broken tools to fail explicitly, so that Claude never acts on a wrong shape.  
\- AC-DRF-002.1: When a tool is classified \`breaking\` or \`gone\`, the system shall mark it degraded in the recipe and the runtime shall pick that up by hot reload.  
\- AC-DRF-002.2: When a degraded tool is invoked, the system shall return a structured error naming the tool and the detected change per AC-EXE-003.4.  
\- AC-DRF-002.3: When some tools in a recipe are degraded, the remaining tools shall continue to serve normally.

REQ-DRF-003: Repair Proposals  
As a solo builder, I want drift to arrive as a diff, so that fixing a recipe is a review rather than a re-capture.  
\- AC-DRF-003.1: When a tool is classified \`schema\_widened\`, the system shall write a proposed recipe patch adding the new optional fields and shall leave existing fields unchanged.  
\- AC-DRF-003.2: When the recipe is in a git repository, the system shall offer to commit proposed patches on a branch.  
\- AC-DRF-003.3: When a Doctor Run finds any \`breaking\` or \`gone\` tool, the system shall notify via the configured webhook.

\----------------------------------------------------------------  
FRD-8 — EJECT TO A STANDALONE PACKAGE  
\----------------------------------------------------------------

\#\# Overview

Eject is the escape hatch. Most of the time the runtime interprets recipes and you never think about code. When you want an artifact you own — to ship it, run it in CI, hand it to a machine that has no Recon install — eject compiles one recipe into a standalone incur package.

It is deliberately not the default path, because making it the default is what made iteration slow.

\#\# Requirements

REQ-EJT-001: Standalone Package Emission  
As a solo builder, I want a self-contained package from one recipe, so that a tool can outlive my Recon install.  
\- AC-EJT-001.1: When the user runs \`recon eject \<recipe\>\`, the system shall emit a TypeScript package building an incur CLI with one command per approved tool, mapping path and required parameters to \`args\` and optional parameters to \`options\`.  
\- AC-EJT-001.2: When emitting a command, the system shall declare an \`output\` schema from the response contract and at least one \`examples\` entry drawn from a fixture.  
\- AC-EJT-001.3: When the package is built, it shall declare \`incur\` as its only runtime dependency and shall import no Recon module.  
\- AC-EJT-001.4: When the same recipe is ejected twice, the system shall produce byte-identical output.  
\- AC-EJT-001.5: When emitting, the system shall write a header in each file naming the source recipe and its version.

REQ-EJT-002: Ejected Execution  
As a solo builder, I want an ejected package to work the same way, so that ejecting is not a behavior change.  
\- AC-EJT-002.1: When an ejected package runs with \`recond\` reachable, it shall execute through the browser relay identically to the interpreted runtime.  
\- AC-EJT-002.2: When an ejected package runs with no relay reachable and Headless Mode configured, it shall execute directly and shall emit the degraded-path notice.  
\- AC-EJT-002.3: When an ejected package is generated, the system shall emit fixture-replay tests that fail non-zero and name each failing tool.

\================================================================  
PART 3 — BLUEPRINTS  
\================================================================

3.1 CONTAINER BLUEPRINT: Recon Capture Extension

\#\# Container Summary  
Chrome MV3 extension running in the user's normal profile. Owns capture and outbound relay execution. It is the only component that ever touches a target origin with the user's session.

\#\# Infrastructure  
MV3 service worker, MAIN-world injected interceptor, content-script bridge, popup UI, offscreen document for Executor Tabs. TypeScript, bundled with Vite. Permissions: \`scripting\`, \`webRequest\`, \`storage\`, \`offscreen\`, \`notifications\`, optional \`debugger\`, host permissions granted per target at record time.

\#\# Entry Points and Boundaries  
Entry points: popup start/stop and annotate, MAIN-world interceptor messages, relay commands from \`recond\` over the local WebSocket. The extension never writes to disk beyond \`chrome.storage\` buffering and never talks to anything but loopback and the target origin.

\#\# System Contracts  
\#\#\# Key Contracts  
An exchange is emitted at most once. Redaction is applied in the service worker before an exchange leaves the extension, so unredacted payloads never cross the loopback boundary. Relay requests are issued only for origins the user granted at record time.  
\#\#\# Integration Contracts  
The extension dials \`ws://127.0.0.1:\<port\>\` and speaks a JSON protocol with two message families: \`exchange.\*\` (capture, extension to daemon) and \`relay.\*\` (execution, daemon to extension, response back).

\#\# Architecture Decision Records

\#\#\# ADR-001: A Chrome extension, because CDP against your real profile is no longer possible  
Context: the goal in Part 0 requires reaching sessions you are already signed into. The obvious alternative to an extension is driving your own Chrome over the DevTools Protocol with \`--remote-debugging-port\`, capturing via \`Network.\*\` and executing via \`Runtime.evaluate\`. That would need no extension, no MV3 constraints, and would see service-worker traffic for free.  
Decision: build a Chrome extension. As of Chrome 136, \`--remote-debugging-port\` and \`--remote-debugging-pipe\` are ignored unless accompanied by a \`--user-data-dir\` pointing at a non-default directory — a deliberate change to stop cookie extraction from real profiles, since non-standard profiles use different encryption keys.  
Consequences: CDP would force a throwaway profile, meaning you sign in again to every target, which defeats the premise entirely. Chrome for Testing keeps the old behavior but is a separate browser with separate sessions, so it fails the same way. The extension is therefore not a preference among options; it is the only route to a live signed-in session, and this ADR should be revisited only if Chrome reverses the restriction.

\#\#\# ADR-002: MAIN-world interception as primary capture, \`chrome.debugger\` as opt-in fallback  
Context: MV3 leaves no single clean way to capture response bodies. \`chrome.webRequest\` exposes request bodies via \`extraInfoSpec: \['requestBody'\]\` but has never exposed response bodies. \`chrome.debugger\` with CDP \`Network.getResponseBody\` does, but shows a persistent "is debugging this browser" infobar, conflicts with DevTools being open, and intermittently fails with "No resource with given identifier found". \`chrome.devtools.network\` is reliable but requires DevTools open for the whole session.  
Decision: inject a MAIN-world script via \`chrome.scripting.registerContentScripts({ world: 'MAIN' })\` wrapping \`window.fetch\` and \`XMLHttpRequest\`, capturing both bodies with no banner. Use \`chrome.webRequest\` in parallel as a completeness oracle — anything it sees that the interceptor did not is flagged \`body\_missing\`. Offer \`chrome.debugger\` as a per-session opt-in, chiefly for the page's own service worker.  
Consequences: the default path is invisible, which matters because capture is the first thing a user does. The coverage gap is measurable rather than silent, and the opt-in closes it. Wrapping page globals can be clobbered by a hostile page; targets where that happens use the debugger path.

\#\#\# ADR-003: Outbound WebSocket to \`recond\` rather than native messaging  
Context: the relay needs a persistent channel between the extension and a local process. Native messaging requires a host manifest per browser and platform. MV3 service workers also terminate after 30 seconds of inactivity.  
Decision: the service worker dials a WebSocket to \`recond\` on loopback. Chrome 116 and later reset the service worker idle timer on WebSocket send and receive, so an active relay keeps the worker alive; \`recond\` sends a heartbeat inside the 30-second window. The extension reconnects with backoff.  
Consequences: installation is the extension plus \`npm i \-g recon\`, with no native host manifest. The worker can still be evicted during long idle gaps, so "extension not connected" is a first-class error state (AC-CON-004.2) rather than a hang. A 5-minute cap on a single request still applies, so relayed calls carry a shorter timeout.

\#\#\# ADR-004: Execute through the browser instead of extracting credentials  
Context: every target is authenticated. The conventional approach lifts cookies or tokens into a local client and reimplements refresh — which cannot read httpOnly cookies at all, and must be redone per target for CSRF schemes and rotation.  
Decision: relay execution issues the request from an Executor Tab on the target origin with \`credentials: 'include'\`. Where the app carries its credential in page state instead, the injected script reads it the same way the app does (AC-EXE-001.3).  
Consequences: auth support is effectively free and identical across targets, and Recon stores no credential. The price is a hard dependency on a running signed-in Chrome — acceptable for the primary persona, unacceptable for cron, hence Headless Mode as an explicit labeled fallback.

3.2 CONTAINER BLUEPRINT: recond — Relay Daemon and Recipe Registry

\#\# Container Summary  
The only always-on Recon process. Holds the extension WebSocket, owns the recipe registry and hot reload, enforces call guards, and relays requests. Deliberately small: no inference, no model calls, no review UI.

\#\# Infrastructure  
TypeScript on Node 22+ / Bun. Hono on loopback with a per-install token required on every request. Recipes and fixtures are plain files; a small SQLite database holds the audit log and capture sessions.

\#\# Entry Points and Boundaries  
Entry points: extension WebSocket, loopback relay and registry API for \`recon \--mcp\` and the CLI, \`recon studio\` writes to the recipe directory. \`recond\` never touches a target origin except in Headless Mode.

\#\# Core Components

\`\`\`component  
name: RecipeRegistry  
container: recond  
responsibilities:  
	\- Loading enabled recipes and validating them against the recipe schema  
	\- Watching the recipe directory and rebuilding the \`ToolSurface\` on change  
	\- Keeping the last valid version of a recipe when a reload fails  
	\- Serving the current \`ToolSurface\` to runtime clients  
\`\`\`

\`\`\`component  
name: RelayBridge  
container: recond  
responsibilities:  
	\- Holding the extension WebSocket and correlating relay requests to responses  
	\- Enforcing per-tool rate limits, destructive-call confirmation, and degraded rejection  
	\- Classifying \`session\_expired\` and relay-unavailable failures  
	\- Writing redacted audit entries  
\`\`\`

\`\`\`component  
name: CaptureStore  
container: recond  
responsibilities:  
	\- Persisting \`CaptureSession\`, \`Exchange\`, and \`AnnotationSpan\` records  
	\- Enforcing redaction invariants before write  
	\- Serving exchange queries to Recon Studio  
\`\`\`

\`\`\`component  
name: DriftWatcher  
container: recond  
responsibilities:  
	\- Replaying read-only fixtures on a schedule  
	\- Classifying drift and marking tools degraded in the recipe  
	\- Writing proposed recipe patches and dispatching notifications  
\`\`\`

\`\`\`model  
name: Recipe  
store: Filesystem (YAML)  
description: Versioned description of one target's tools, auth source, and fixtures. The unit the runtime loads and the artifact the user owns.  
fields:  
	\- version: integer (required)  
	\- name: string (required, used as the tool namespace)  
	\- enabled: boolean (required)  
	\- target.base\_url: string (required)  
	\- auth.mode: enum browser\_relay | headless (required)  
	\- auth.credential\_source: descriptor only, never a value  
	\- tools\[\]: name, description, side\_effect, confidence, observations, request, response, fixtures, flags  
constraints:  
	\- no credential values may appear anywhere in the document  
	\- tool names unique within a recipe  
	\- every approved tool references at least one fixture  
\`\`\`

\#RecipeRegistry owns the only mutable shared state in the runtime, and \#RelayBridge reads the current tool contract from it when validating a call. Keeping them in one process means a hot reload and an in-flight call cannot disagree about a tool's shape, which is why the registry is not pushed out to the MCP clients.

\#RelayBridge enforces every guard before forwarding to the extension, so a guard cannot be bypassed by calling \`recond\` directly or by an ejected package. Guards deliberately do not live in generated or interpreted client code, which is meant to stay a thin typed shell that is trustworthy on inspection.

\#DriftWatcher writes degradation flags into the recipe rather than into memory, so degradation propagates to every client through the same hot-reload path as any other recipe edit. This is why drift needs no client-facing mechanism of its own.

\#\# Architecture Decision Records

\#\#\# ADR-005: Interpret recipes at runtime; eject on demand  
Context: the earlier design compiled each recipe into its own incur package, registered separately with each client. That made every new target a build plus an install plus a client registration, and made every description edit a regenerate-rebuild-reconnect cycle.  
Decision: \`recond\` loads recipes and the runtime registers tools dynamically — incur's \`.command()\` is a runtime call, so the command tree is built in a loop at startup and rebuilt on reload. \`recon eject\` remains for when a standalone artifact is wanted (FRD-8).  
Consequences: you register a client once, ever, and every later recipe appears without a rebuild (AC-CON-001.4). A description edit reaches a running client in seconds through \`notifications/tools/list\_changed\`, which Claude Code has handled correctly since v2.1.0 — this directly serves the selection-accuracy metric, since that metric is tuned by editing descriptions. The dependency is that incur's MCP layer supports re-registering tools mid-session; if it does not, the fallback is a thin wrapper that re-emits \`tools/list\` on reload, and this must be spiked in M0 before WO-008 starts. Clients that ignore \`listChanged\` degrade to picking up changes at restart (AC-RUN-002.4).

\#\#\# ADR-006: Split dev-time studio from the always-on runtime  
Context: the earlier design put inference, description generation, the review UI, and the relay in one daemon, so a heavyweight process ran permanently to serve a tiny function.  
Decision: \`recond\` keeps only the relay, registry, capture store, and drift watcher. Inference, model calls, and the review UI move into \`recon studio\`, which is started when building a recipe and quit afterwards.  
Consequences: the always-on footprint is small enough to leave running (TR-5), and the model-calling code is never resident during normal use. The cost is a second process to start when recording, which is acceptable because recording is already an explicit act.

\#\#\# ADR-007: One tool surface across all enabled recipes  
Context: tools could be scoped per recipe, per profile, or exposed together. Scoping per recipe would mean a client registration per target, which reintroduces the friction ADR-005 removes.  
Decision: the runtime exposes every enabled recipe's tools in one surface, namespaced \`\<recipe\>\_\<tool\>\`, with an \`enabled\` flag per recipe as the control.  
Consequences: one registration covers everything, which is what makes Part 0's "installation happens once" true. The risk is a wide tool surface; tool search is on by default in current Claude Code, which absorbs most of it, and the \`enabled\` flag handles the rest. Behavior on a wide surface in Claude Desktop is unverified and is an open question, not a settled decision.

3.3 CONTAINER BLUEPRINT: Recon Runtime Clients

\#\# Container Summary  
Two thin surfaces over the same registry: \`recon \--mcp\`, a stdio MCP server launched by Claude Desktop or Claude Code, and \`recon \<recipe\> \<tool\>\`, the shell CLI. Both are built with incur and hold no state.

\#\# Infrastructure  
TypeScript on incur. Zod schemas built at load from recipe JSON Schema. TOON default output with \`--format json|yaml|md\`. Distributed as an npm package and as a \`.mcpb\` bundle.

\#\# Entry Points and Boundaries  
Entry points: stdio MCP from a Claude client, argv from a shell. Both call \`recond\` over loopback and never issue a target request directly.

\#\# System Contracts  
\#\#\# Key Contracts  
A client never holds a credential, never enforces a guard, and never caches a tool contract across a reload. A tool result is shaped per REQ-RUN-004 before it leaves the client.  
\#\#\# Integration Contracts  
\`POST /relay/:recipe/:tool\` and \`GET /registry\` on loopback with the install token. MCP over stdio; MCP over HTTP at \`/mcp\` when served.

\`\`\`component  
name: ToolSurfaceBuilder  
container: Recon Runtime Clients  
responsibilities:  
	\- Fetching the current \`ToolSurface\` from \#RecipeRegistry  
	\- Converting stored JSON Schema to Zod and registering incur commands per tool  
	\- Emitting \`notifications/tools/list\_changed\` when the surface changes  
\`\`\`

\`\`\`component  
name: RelayClient  
container: Recon Runtime Clients  
responsibilities:  
	\- Validating arguments and building the request descriptor  
	\- Calling \`recond\` and emitting progress notifications on long calls  
	\- Applying the \`PrimaryPayloadPath\` and truncation to the result  
	\- Translating relay failures into legible client-facing errors  
\`\`\`

\#ToolSurfaceBuilder subscribes to \#RecipeRegistry rather than reading recipe files itself, so a client and the daemon can never disagree about which tools exist. \#RelayClient depends on \#RelayBridge for every call and owns none of the guards, which keeps the client small enough to be reviewed at a glance.

\#\# Architecture Decision Records

\#\#\# ADR-008: Claude Desktop MCPB is the primary install path  
Context: the outcome in Part 0 is written for Claude Desktop. Its install options are hand-edited JSON or an MCPB bundle. Claude Code takes \`mcp add\`.  
Decision: \`recon bundle\` emits a \`.mcpb\` — a zip with a \`manifest.json\` — installed by double-click, with relay URL and install token surfaced as a settings form generated from \`user\_config\`. Claude Code registration stays a one-line \`mcp add\`.  
Consequences: setup requires no JSON editing, and Node ships inside Claude Desktop on macOS and Windows, so a TypeScript package needs no runtime install there. The bundle cannot bundle \`recond\` or Chrome, so legible in-chat failure (REQ-CON-004) is a hard requirement rather than polish — a chat client gives the user no terminal to diagnose from. \`skills add\` and \`--llms\` serve Claude Code only, since incur's agent registry covers coding agents; Claude Desktop therefore selects tools purely on names and descriptions, which raises the stakes on FRD-2 rather than adding work.

3.4 CONTAINER BLUEPRINT: Recon Studio

\#\# Container Summary  
Dev-time only. Runs inference, generates names and descriptions, and hosts the review UI. Started when building a recipe, quit afterwards.

\#\# Infrastructure  
TypeScript on Node 22+ / Bun. Hono-served SPA on loopback. Optional local or remote model endpoint for description generation.

\#\# Core Components

\`\`\`component  
name: InferenceEngine  
container: Recon Studio  
responsibilities:  
	\- Grouping exchanges into \`EndpointTemplate\` records  
	\- Deriving request and response JSON Schemas with required, optional, and open-enum inference  
	\- Splitting GraphQL exchanges by operation name  
	\- Classifying side effects and scoring \`Confidence\`  
	\- Selecting the \`PrimaryPayloadPath\` and detecting pagination  
\`\`\`

\`\`\`component  
name: DescriptionWriter  
container: Recon Studio  
responsibilities:  
	\- Generating snake\_case verb-object tool names  
	\- Generating selection-oriented descriptions from \`AnnotationSpan\` notes, provenance, and redacted samples  
	\- Routing to a local model endpoint when configured  
\`\`\`

\`\`\`component  
name: ReviewApp  
container: Recon Studio  
responsibilities:  
	\- Presenting candidates with evidence for promotion  
	\- Writing edits back to the recipe and marking fields \`user\_edited\`  
	\- Enforcing per-candidate approval for write and destructive tools  
	\- Merging re-inferred values without clobbering user edits  
\`\`\`

\`\`\`component  
name: PackageEjector  
container: Recon Studio  
responsibilities:  
	\- Emitting a standalone incur package and fixture-replay tests for one recipe  
	\- Guaranteeing deterministic, dependency-minimal output  
\`\`\`

\#InferenceEngine reads exchanges from \#CaptureStore and writes candidates through \#ReviewApp, calling \#DescriptionWriter for naming. Inference is deterministic and replayable while description generation is a model call, so separating them lets a recipe be re-inferred offline without regenerating prose the user has already edited.

\#ReviewApp writes only to the recipe directory, and \#RecipeRegistry picks the change up by hot reload. Studio therefore needs no runtime coupling to \`recond\` beyond the filesystem, which is what allows it to be started and stopped freely.

\================================================================  
PART 4 — WORK ORDERS  
\================================================================

Every Work Order traces to Part 0\. The ordering is chosen so that the first end-to-end demo is "record a target, then use it from Claude Desktop", not "the generator works".

\---

WO-001 — Capture extension: MAIN-world interception and session lifecycle

\#\# Summary  
Deliver the Chrome MV3 extension that records scoped, named capture sessions with request and response bodies and streams redacted exchanges to \`recond\`. This is the input to everything downstream.

\#\# In Scope  
MV3 scaffold and permissions; MAIN-world interceptor for \`fetch\` and \`XMLHttpRequest\`; \`chrome.webRequest\` completeness oracle; popup with start/stop, session naming, and live count; origin scoping; noise filtering; redaction in the service worker before emission; buffering and delivery over the loopback WebSocket.

\#\# Out of Scope  
Debugger fallback, provenance, and annotation (WO-002). Relay execution (WO-009). HAR import (WO-003).

\#\# Requirements  
FRD-1 — REQ-CAP-001, REQ-CAP-002 (AC-CAP-002.1 through .3), REQ-CAP-004, REQ-CAP-005.

\#\# Blueprints  
\- Recon Capture Extension — MV3 structure, ADR-002 interception strategy, the redaction boundary, ADR-003 transport.  
\- recond — \#CaptureStore write contract.

\#\# E2E Acceptance Tests

\#\#\# COV\_CAP\_001: Scoped session capture with bodies  
File: \`e2e/capture/session-capture.spec.ts\`  
Tags: extension, capture | Priority: P0

@COV\_CAP\_001.1 — should capture request and response bodies for in-scope traffic  
1\. Launch Chrome with the extension loaded against a fixture SPA.  
2\. Start a session named "orders" from the popup.  
3\. Trigger a POST that creates an order and a GET that lists orders.  
4\. Assert the popup badge shows 2\.  
5\. Stop the session and assert \`recond\` received 2 exchanges with non-empty request and response bodies.

@COV\_CAP\_001.2 — should exclude out-of-scope and noise traffic  
1\. Start a session on the fixture SPA.  
2\. Trigger a request to a third-party analytics host and a request for a CSS asset.  
3\. Stop the session and assert neither exchange was persisted.

@COV\_CAP\_001.3 — should redact credentials before persistence  
1\. Start a session on a fixture SPA that sends an \`authorization\` header and a body containing \`password\`.  
2\. Trigger the request and stop the session.  
3\. Assert the persisted exchange contains placeholders for both, and assert the original values appear nowhere on disk.

\---

WO-002 — Capture extension: provenance, annotation, debugger fallback

\#\# Summary  
Attach intent to captured traffic — the control the user clicked, and the note they typed — and add opt-in \`chrome.debugger\` capture so requests the MAIN-world interceptor cannot see are still recorded. This is what makes generated descriptions specific enough for a chat client.

\#\# In Scope  
Content-script gesture tracking with accessible name and role; route and title capture; the 2-second attribution window and \`background\` marking; in-popup annotation with Annotation Span persistence and span-to-candidate propagation; per-session debugger opt-in with attach/detach and \`Network.getResponseBody\`; reconciliation so an exchange captured by both paths is emitted once.

\#\# Out of Scope  
Description generation itself (WO-006).

\#\# Requirements  
FRD-1 — REQ-CAP-003, REQ-CAP-007, AC-CAP-002.4.

\#\# Blueprints  
\- Recon Capture Extension — ADR-002 fallback path and the at-most-once emission contract.

\#\# E2E Acceptance Tests

\#\#\# COV\_CAP\_003: Provenance attribution  
File: \`e2e/capture/provenance.spec.ts\`  
Tags: extension, capture | Priority: P1

@COV\_CAP\_003.1 — should attach the activating control to a user-initiated request  
1\. Start a session and click the button labeled "Create order".  
2\. Stop the session and assert the exchange carries provenance with accessible name "Create order" and the current route.

@COV\_CAP\_003.2 — should mark polling traffic as background  
1\. Start a session on a fixture SPA that polls every second and wait 5 seconds without interacting.  
2\. Stop the session and assert every captured exchange is marked \`background\` with no provenance.

\#\#\# COV\_CAP\_007: Usage annotation  
File: \`e2e/capture/annotation.spec.ts\`  
Tags: extension, capture | Priority: P0

@COV\_CAP\_007.1 — should attach a recorded note to the candidates derived from its span  
1\. Start a session and trigger two requests.  
2\. Attach the note "transitions an issue to done" from the popup.  
3\. Trigger a third request, stop the session, and run inference.  
4\. Assert the candidate derived from the third exchange carries the note and the earlier candidates do not.

@COV\_CAP\_007.2 — should produce candidates from an unannotated session  
1\. Record a session with no notes and run inference.  
2\. Assert candidates are produced and none is blocked on a missing annotation.

\---

WO-003 — recond foundation: relay daemon, capture store, control CLI, HAR import

\#\# Summary  
Stand up the always-on daemon: loopback API, extension WebSocket with heartbeat, capture storage with redaction invariants, single-instance behavior, and HAR import. Everything else depends on this substrate.

\#\# In Scope  
Daemon process and lifecycle; loopback binding with per-install token; single-instance detection; auto-start from clients; extension WebSocket with heartbeat inside the 30-second window and backoff reconnect; \#CaptureStore; \`recon start|stop|status|sessions|import\`; HAR import applying live-capture filtering and redaction.

\#\# Out of Scope  
Recipe registry and hot reload (WO-004). Relay execution (WO-009). Inference (WO-005).

\#\# Requirements  
FRD-1 — REQ-CAP-006 and the storage side of REQ-CAP-005. FRD-4 — REQ-RUN-003.

\#\# Blueprints  
\- recond — infrastructure, \#CaptureStore, ADR-003 heartbeat requirement, ADR-006 scope boundary.

\#\# E2E Acceptance Tests

\#\#\# COV\_RUN\_003: Daemon lifecycle  
File: \`e2e/daemon/lifecycle.spec.ts\`  
Tags: daemon | Priority: P0

@COV\_RUN\_003.1 — should refuse to start a second instance  
1\. Start \`recond\`, then start it again.  
2\. Assert the second exits non-zero with a message naming the running instance, and assert only one port is bound.

@COV\_RUN\_003.2 — should auto-start from a client and survive a restart  
1\. With \`recond\` stopped, run a CLI command and assert it starts the daemon and completes.  
2\. Kill \`recond\`, run the command again, and assert it recovers with no user action.

\#\#\# COV\_CAP\_006: HAR import parity  
File: \`e2e/daemon/har-import.spec.ts\`  
Tags: daemon, capture | Priority: P1

@COV\_CAP\_006.1 — should import a HAR with filtering and redaction applied  
1\. Run \`recon import fixtures/orders.har \--name orders-har\`.  
2\. Assert the session contains only JSON exchanges from the primary origin and that \`authorization\` values are placeholders.

@COV\_CAP\_006.2 — should mark body-less entries rather than dropping them  
1\. Import a HAR whose entries lack response content.  
2\. Assert every resulting exchange is marked \`body\_missing\` and none was discarded.

\---

WO-004 — Recipe registry and hot reload

\#\# Summary  
Deliver the recipe format and the registry that loads it: validation, the enabled flag, directory watching, safe reload, and the tool surface served to runtime clients. This is the mechanism that makes install-once true.

\#\# In Scope  
Recipe YAML schema and versioned migrations; \#RecipeRegistry load and validation; \`enabled\` handling; fixture load-time validation with degraded exposure; directory watch with 5-second reload; last-valid-version retention on failed reload; per-recipe failure isolation; \`GET /registry\`.

\#\# Out of Scope  
Client-side registration and \`listChanged\` emission (WO-008). Review UI writes (WO-007).

\#\# Requirements  
FRD-3 — REQ-REC-001. FRD-4 — REQ-RUN-001 (AC-RUN-001.1 and .4 and .5), REQ-RUN-002 (AC-RUN-002.1 and .3).

\#\# Blueprints  
\- recond — \#RecipeRegistry, the \`Recipe\` model, ADR-005, ADR-007.

\#\# E2E Acceptance Tests

\#\#\# COV\_RUN\_001: Registry loading  
File: \`e2e/daemon/registry.spec.ts\`  
Tags: daemon, runtime | Priority: P0

@COV\_RUN\_001.1 — should isolate a broken recipe from the rest  
1\. Place three recipes on disk, one with an invalid schema.  
2\. Start \`recond\` and assert the two valid recipes serve their tools and the failure is reported by recipe name.

@COV\_RUN\_001.2 — should expose a fixture-invalid tool as degraded rather than omitting it  
1\. Load a recipe whose stored fixture no longer matches its declared schema.  
2\. Assert the tool appears in the surface marked degraded and names the failing fixture.

\#\#\# COV\_RUN\_002: Hot reload  
File: \`e2e/daemon/hot-reload.spec.ts\`  
Tags: daemon, runtime | Priority: P0

@COV\_RUN\_002.1 — should pick up a description edit within 5 seconds  
1\. Edit a tool description in a recipe file.  
2\. Poll \`GET /registry\` and assert the new description is served within 5 seconds.

@COV\_RUN\_002.2 — should keep serving the last valid version when a reload fails  
1\. Write invalid YAML over a loaded recipe.  
2\. Assert the previously loaded tools continue to serve and the error is reported.

\---

WO-005 — Inference engine

\#\# Summary  
Turn stored exchanges into scored candidate tools: endpoint templating, schema inference, GraphQL operation splitting, side-effect classification, pagination, and primary-payload selection. Deterministic and replayable, with no model calls.

\#\# In Scope  
\#InferenceEngine end to end; \`EndpointTemplate\` grouping and parameter naming; required/optional and open-enum inference; \`sparse\` marking; GraphQL grouping with variables-derived schemas and failed-operation exclusion; read/write/destructive classification; pagination detection; primary payload path; confidence scoring.

\#\# Out of Scope  
Naming and descriptions (WO-006). Promotion (WO-007).

\#\# Requirements  
FRD-2 — REQ-INF-001, REQ-INF-002, REQ-INF-003, REQ-INF-004, REQ-INF-005.

\#\# Blueprints  
\- Recon Studio — \#InferenceEngine and its separation from \#DescriptionWriter.

\#\# E2E Acceptance Tests

\#\#\# COV\_INF\_001: Templating and schema inference  
File: \`e2e/studio/inference.spec.ts\`  
Tags: studio, inference | Priority: P0

@COV\_INF\_001.1 — should collapse identifier-varying requests into one templated candidate  
1\. Import a session with GETs to \`/orders/1042\`, \`/orders/1043\`, \`/orders/1044\` and run inference.  
2\. Assert exactly one candidate exists with path \`/orders/{orderId}\`, named from the response \`id\` field.

@COV\_INF\_001.2 — should mark fields optional when not present in every observation  
1\. Import a session with three POSTs where \`note\` appears in one, and run inference.  
2\. Assert \`note\` is optional and the always-present fields are required.

\#\#\# COV\_INF\_004: GraphQL splitting  
File: \`e2e/studio/graphql-inference.spec.ts\`  
Tags: studio, inference, graphql | Priority: P0

@COV\_INF\_004.1 — should emit one candidate per operation name  
1\. Import a session with POSTs to \`/graphql\` carrying \`GetIssue\`, \`CreateIssue\`, \`GetIssue\`.  
2\. Run inference and assert two candidates exist with variables-derived schemas.

@COV\_INF\_004.2 — should exclude 200-with-errors exchanges from schema inference  
1\. Import a GraphQL session where one \`CreateIssue\` returns HTTP 200 with a populated \`errors\` array.  
2\. Assert the failed exchange did not contribute to the response contract.

\---

WO-006 — Naming and description generation

\#\# Summary  
Generate tool names and selection-oriented descriptions from annotations, provenance, and redacted samples, with local-model support. This component determines whether Claude Desktop picks the right tool, and there is no CLI fallback in a chat client.

\#\# In Scope  
\#DescriptionWriter; verb-object snake\_case naming; three-sentence what/returns/when format; annotation-over-provenance priority; collision disambiguation within a recipe; redaction guarantee on model input; configurable local endpoint; an offline eval harness scoring selection accuracy against a labeled task set.

\#\# Out of Scope  
Inference (WO-005). Review editing (WO-007).

\#\# Requirements  
FRD-2 — REQ-INF-006. FRD-1 — AC-CAP-007.3.

\#\# Blueprints  
\- Recon Studio — \#DescriptionWriter and its separation from \#InferenceEngine.

\#\# E2E Acceptance Tests

\#\#\# COV\_INF\_006: Description generation  
File: \`e2e/studio/descriptions.spec.ts\`  
Tags: studio, inference | Priority: P0

@COV\_INF\_006.1 — should prefer a user annotation over UI provenance  
1\. Run description generation on a candidate whose Annotation Span says "transitions an issue to done" and whose provenance says "Save".  
2\. Assert the description reflects the transition intent rather than the button label.

@COV\_INF\_006.2 — should send only redacted payloads to the model  
1\. Configure a recording mock model endpoint and run generation over a session containing a credential header.  
2\. Assert no request to the endpoint contains the original credential value.

@COV\_INF\_006.3 — should meet the selection-accuracy bar  
1\. Run the eval harness over the labeled task set for the reference recipe.  
2\. Assert selection accuracy is at least 90%.

\---

WO-007 — Review UI and recipe merge

\#\# Summary  
Deliver the studio review surface where candidates become tools, and the merge behavior that preserves hand edits across recaptures. Because the runtime hot-reloads, an approval here is live within seconds.

\#\# In Scope  
\#ReviewApp; candidate list with evidence including annotation and sample exchange; inline editing with \`user\_edited\` marking; read-only bulk approve; individual approval for write and destructive; \`confirm\` parameter injection; merge preserving user edits; \`unverified\` retention; fixture-conflict reporting; fixture storage with a redaction gate on write.

\#\# Out of Scope  
Registry loading (WO-004). Eject (WO-012).

\#\# Requirements  
FRD-3 — REQ-REC-002, REQ-REC-003, REQ-REC-004.

\#\# Blueprints  
\- Recon Studio — \#ReviewApp and its filesystem-only coupling to \#RecipeRegistry.

\#\# E2E Acceptance Tests

\#\#\# COV\_REC\_002: Promotion gating  
File: \`e2e/studio/review.spec.ts\`  
Tags: studio, review | Priority: P0

@COV\_REC\_002.1 — should restrict bulk approve to read candidates  
1\. Open review for a session with read, write, and destructive candidates and click "Approve all reads".  
2\. Assert only read candidates are approved.

@COV\_REC\_002.2 — should add a confirm parameter when a destructive candidate is approved  
1\. Approve \`delete\_order\` individually.  
2\. Assert the recipe entry includes a required \`confirm\` parameter.

@COV\_REC\_002.3 — should reach a running client without a restart  
1\. With \`recond\` running and a client connected, edit a description in review and save.  
2\. Assert the client's tool list reflects the new description within 30 seconds and no client restart occurred.

\#\#\# COV\_REC\_003: Non-destructive regeneration  
File: \`e2e/studio/recipe-merge.spec.ts\`  
Tags: studio, review | Priority: P0

@COV\_REC\_003.1 — should preserve user-edited fields across re-inference  
1\. Edit a description, re-record the same workflow, and re-run inference.  
2\. Assert the edited description is unchanged and the inferred one is stored as a suggestion.

@COV\_REC\_003.2 — should retain tools absent from a new capture  
1\. Re-run inference from a session missing one previously approved tool.  
2\. Assert the tool remains, marked \`unverified\` with a last-observed date.

\---

WO-008 — Runtime clients: tool surface over CLI and MCP

\#\# Summary  
Build the thin clients that turn the registry's tool surface into a live CLI and a live MCP server, including dynamic registration and \`listChanged\` emission. This is where a recipe becomes something Claude can call.

\#\# In Scope  
\#ToolSurfaceBuilder; JSON Schema to Zod conversion at load; dynamic incur command registration in a loop; \`\<recipe\>\_\<tool\>\` MCP naming and \`recon \<recipe\> \<tool\>\` CLI naming; namespace collision behavior; \`listChanged\` emission and the no-listChanged fallback; \#RelayClient argument validation and error translation; result shaping, truncation, and TOON default with format flags.

\#\# Out of Scope  
The relay itself (WO-009). Installation (WO-010).

\#\# Requirements  
FRD-4 — REQ-RUN-001 (AC-RUN-001.2 and .3), REQ-RUN-002 (AC-RUN-002.2 and .4), REQ-RUN-004.

\#\# Blueprints  
\- Recon Runtime Clients — \#ToolSurfaceBuilder, \#RelayClient, ADR-005.

\#\# E2E Acceptance Tests

\#\#\# COV\_RUN\_004: Live tool surface  
File: \`e2e/runtime/surface.spec.ts\`  
Tags: runtime, mcp | Priority: P0

@COV\_RUN\_004.1 — should expose every enabled recipe's tools namespaced, over both surfaces  
1\. Load two recipes that each define a tool named \`list\`.  
2\. Assert \`tools/list\` returns both, namespaced, and assert the CLI exposes each as \`recon \<recipe\> list\`.  
3\. Assert the MCP JSON Schema for a tool matches the Zod schema the CLI validates against.

@COV\_RUN\_004.2 — should announce a changed surface without a restart  
1\. With an MCP client connected that declares \`listChanged\`, add a new approved tool to a recipe on disk.  
2\. Assert \`notifications/tools/list\_changed\` is sent and a subsequent \`tools/list\` includes the new tool.

@COV\_RUN\_004.3 — should trim and truncate results  
1\. Invoke a read tool whose raw response is 40 KB with a Primary Payload Path selecting a 1 KB subtree.  
2\. Assert the returned result is the subtree, and assert the same call with \`raw\` returns the full body.  
3\. Invoke a tool whose trimmed result exceeds 32 KB and assert the result states it was truncated and reports the untrimmed size.

\---

WO-009 — Relay execution

\#\# Summary  
Deliver the execution path that makes tools work against authenticated targets: loopback relay, extension-side Executor Tabs, page-state credential handling, session-expiry classification, and call guards.

\#\# In Scope  
\#RelayBridge correlation and timeouts; extension relay handler issuing same-origin credentialed \`fetch\`; offscreen Executor Tab creation; page-state credential reads per the recipe's auth descriptor; 401/403/login-redirect classification and browser notification; per-tool rate limiting; destructive confirmation; degraded rejection; redacted audit log.

\#\# Out of Scope  
Headless Mode (WO-013). Client-facing error wording (WO-010).

\#\# Requirements  
FRD-6 — REQ-EXE-001, REQ-EXE-002, REQ-EXE-003.

\#\# Blueprints  
\- Recon Capture Extension — ADR-003 transport, ADR-004 execution model.  
\- recond — \#RelayBridge and its guard-ownership rationale.

\#\# E2E Acceptance Tests

\#\#\# COV\_EXE\_001: Browser relay  
File: \`e2e/relay/execution.spec.ts\`  
Tags: relay, extension | Priority: P0

@COV\_EXE\_001.1 — should execute with the live browser session  
1\. Sign in to the fixture app in the browser under test and invoke a read tool.  
2\. Assert the fixture server saw the session cookie and the relay returned the trimmed payload.

@COV\_EXE\_001.2 — should carry a page-state credential when the recipe declares one  
1\. Configure the fixture app to hold a bearer token in page state with a CSRF header, and record a recipe against it.  
2\. Invoke a tool and assert the fixture server received both the token and the CSRF header, and assert neither value was persisted.

\#\#\# COV\_EXE\_002: Session expiry  
File: \`e2e/relay/session-expiry.spec.ts\`  
Tags: relay | Priority: P0

@COV\_EXE\_002.1 — should classify a 401 as session\_expired and not retry  
1\. Invalidate the fixture app's session server-side and invoke a tool.  
2\. Assert classification \`session\_expired\` and assert the fixture server recorded exactly one request.

\#\#\# COV\_EXE\_003: Call guards  
File: \`e2e/relay/guards.spec.ts\`  
Tags: relay | Priority: P0

@COV\_EXE\_003.1 — should reject a destructive call missing confirm before any network request  
1\. Invoke \`delete\_order\` without \`confirm\`.  
2\. Assert rejection and assert the fixture server recorded zero requests.

@COV\_EXE\_003.2 — should reject a degraded tool before any network request  
1\. Mark a tool degraded in its recipe and invoke it.  
2\. Assert a structured error naming the tool and the detected change, with zero requests recorded.

\---

WO-010 — Connector installation

\#\# Summary  
Make installation a one-time act: a double-clickable \`.mcpb\` for Claude Desktop, a one-line \`mcp add\` for Claude Code, progress notifications on long calls, and failures a user can read inside a chat window.

\#\# In Scope  
\`recon bundle\` emitting \`.mcpb\` with \`manifest.json\` and \`user\_config\` for relay URL and install token; Claude Desktop install verification including new-recipe visibility without reinstall; \`recon mcp add \--agent claude-code\` with scope reporting and reserved-name handling; \`recon skills add\`; progress notifications and timeout ceiling; the four client-facing error states.

\#\# Out of Scope  
Relay internals (WO-009).

\#\# Requirements  
FRD-5 — REQ-CON-001, REQ-CON-002, REQ-CON-003, REQ-CON-004.

\#\# Blueprints  
\- Recon Runtime Clients — ADR-008 and its consequences.

\#\# E2E Acceptance Tests

\#\#\# COV\_CON\_001: Claude Desktop installation  
File: \`e2e/connector/desktop.spec.ts\`  
Tags: connector, desktop, mcpb | Priority: P0

@COV\_CON\_001.1 — should install by bundle and expose tools  
1\. Run \`recon bundle\`, install the \`.mcpb\` into a scratch Claude Desktop profile, and complete the settings form.  
2\. Assert the server starts and \`tools/list\` returns the enabled recipes' tools.

@COV\_CON\_001.2 — should surface a newly approved recipe without reinstalling  
1\. With the bundle installed, approve a tool in a new recipe.  
2\. Assert the tool becomes callable with no reinstall and no bundle rebuild.

\#\#\# COV\_CON\_002: Claude Code installation  
File: \`e2e/connector/claude-code.spec.ts\`  
Tags: connector, mcp | Priority: P0

@COV\_CON\_002.1 — should register and report connected  
1\. Run \`recon mcp add \--agent claude-code\` against a scratch config.  
2\. Assert a stdio entry invoking \`recon \--mcp\` was written, the reported scope matches the changed file, and \`claude mcp list\` reports connected.

@COV\_CON\_002.2 — should refuse a reserved server name  
1\. Attempt registration under the name \`workspace\`.  
2\. Assert the registered name is suffixed and registration succeeds.

\#\#\# COV\_CON\_004: Legible failure  
File: \`e2e/connector/failures.spec.ts\`  
Tags: connector | Priority: P0

@COV\_CON\_004.1 — should explain each failure state in the tool result  
1\. With \`recond\` stopped, invoke a tool and assert the result states the relay is not running and how to start it.  
2\. With \`recond\` running and the extension disabled, assert the result names the disconnected extension and the target.  
3\. With the session invalidated, assert the result names the target and instructs sign-in.  
4\. Assert no case retried and none fell back to headless.

@COV\_CON\_003.1 — should keep a slow call alive with progress notifications  
1\. Configure the fixture app to delay a read response by 7 minutes.  
2\. Invoke the tool over MCP and assert progress notifications arrive at least once per minute and the call returns successfully.

\---

WO-011 — Drift detection

\#\# Summary  
Keep recipes alive: replay read-only fixtures on a schedule, classify drift, degrade broken tools through the recipe, and propose patches.

\#\# In Scope  
\#DriftWatcher; scheduled and on-demand \`recon doctor\`; read-only replay enforcement; five-way classification; degradation written into the recipe so it propagates by hot reload; healthy-tool isolation; schema-widening patch proposals; optional git branch commit; webhook notification.

\#\# Out of Scope  
Automatic approval of proposed patches. Rejection behavior at call time (WO-009).

\#\# Requirements  
FRD-7 — REQ-DRF-001, REQ-DRF-002, REQ-DRF-003.

\#\# Blueprints  
\- recond — \#DriftWatcher and its recipe-write propagation path.

\#\# E2E Acceptance Tests

\#\#\# COV\_DRF\_001: Doctor runs  
File: \`e2e/drift/doctor.spec.ts\`  
Tags: drift | Priority: P0

@COV\_DRF\_001.1 — should never replay write or destructive fixtures  
1\. Run \`recon doctor\` against a recipe with read, write, and destructive tools.  
2\. Assert the fixture server received requests only for read tools.

@COV\_DRF\_001.2 — should classify an added optional field as schema\_widened and propose a patch  
1\. Add an optional field to the fixture app's response and run \`doctor\`.  
2\. Assert classification \`schema\_widened\` and a patch adding the field as optional with no other change.

\#\#\# COV\_DRF\_002: Degradation propagation  
File: \`e2e/drift/degradation.spec.ts\`  
Tags: drift, runtime | Priority: P0

@COV\_DRF\_002.1 — should degrade a tool through hot reload while healthy tools continue  
1\. Remove a required field from the fixture app's response and run \`doctor\`.  
2\. Assert the recipe is updated, the running client reflects degradation without a restart, the affected tool fails before issuing a request, and an unaffected tool still succeeds.

\---

WO-012 — Eject to a standalone package

\#\# Summary  
Compile one recipe into a self-contained incur package for when an artifact needs to be owned, shipped, or run where Recon is not installed.

\#\# In Scope  
\#PackageEjector; recipe-to-Zod emission; args/options mapping; output schemas; fixture-derived examples; fixture-replay tests; determinism and the single-dependency guarantee; relay-first execution with headless fallback in the ejected package.

\#\# Out of Scope  
Publishing to a registry. Making eject the default path.

\#\# Requirements  
FRD-8 — REQ-EJT-001, REQ-EJT-002.

\#\# Blueprints  
\- Recon Studio — \#PackageEjector.  
\- Recon Runtime Clients — the execution semantics an ejected package must match.

\#\# E2E Acceptance Tests

\#\#\# COV\_EJT\_001: Ejected package  
File: \`e2e/eject/package.spec.ts\`  
Tags: eject, cli | Priority: P1

@COV\_EJT\_001.1 — should emit a runnable, dependency-minimal, deterministic package  
1\. Eject the reference recipe twice into separate directories and assert the trees are byte-identical.  
2\. Assert \`package.json\` declares \`incur\` as the only runtime dependency and no Recon module is imported.  
3\. Build and run a read command against the fixture app and assert the output matches the interpreted runtime for the same arguments.

@COV\_EJT\_001.2 — should fail fixture replay loudly  
1\. Alter a stored fixture to contradict its schema and run the emitted tests.  
2\. Assert non-zero exit naming the failing tool.

\---

WO-013 — Headless mode

\#\# Summary  
Enable unattended execution from cron by exporting a target's session to the OS keychain and executing from \`recond\`, always labeled as the degraded path.

\#\# In Scope  
Explicit per-target opt-in; session export into the OS keychain with only a reference in config; direct execution with recipe-declared refresh and single retry on 401; mandatory degraded-path notice on every invocation; keychain clearing and relay guidance on refresh failure.

\#\# Out of Scope  
Any implicit fallback from relay to headless.

\#\# Requirements  
FRD-6 — REQ-EXE-004.

\#\# Blueprints  
\- Recon Capture Extension — ADR-004 and its stated cost.  
\- recond — \#RelayBridge headless execution path.

\#\# E2E Acceptance Tests

\#\#\# COV\_EXE\_004: Headless execution  
File: \`e2e/relay/headless.spec.ts\`  
Tags: relay, headless | Priority: P1

@COV\_EXE\_004.1 — should execute without the browser and announce the degraded path  
1\. Enable headless mode for the fixture target and close the browser.  
2\. Invoke a read tool and assert success plus a degraded-path notice.  
3\. Assert the config contains a keychain reference and no session value.

@COV\_EXE\_004.2 — should clear a dead session and direct the user back to relay  
1\. Invalidate the stored session and its refresh endpoint, then invoke a tool.  
2\. Assert non-zero exit, a message requiring browser relay, and an empty keychain entry.

\================================================================  
PART 5 — DELIVERY AND OPEN QUESTIONS  
\================================================================

5.1 MILESTONES

M0 — Prove the two things that can kill this (2 weeks).  
WO-003 (HAR import path only), WO-005, WO-006, and a spike on incur dynamic registration.  
Two exit criteria. First, tool-selection accuracy at or above 90% on the reference recipe — if descriptions cannot carry a chat client to the right tool, nothing downstream matters. Second, confirmation that incur's MCP layer can re-register tools mid-session and emit \`listChanged\`; if it cannot, decide the wrapper fallback before WO-008 starts. No extension and no relay in this milestone.

M1 — Record, then use it from Claude Desktop (6 weeks).  
WO-001, WO-002, WO-004, WO-007, WO-008, WO-009, WO-010.  
Exit criterion is Part 0 verbatim: record a live authenticated target, approve, and complete a real action from Claude Desktop, with a second recipe added afterwards that appears without reinstalling anything.

M2 — Keep it true (3 weeks).  
WO-011 plus recipe migrations. Exit criterion: a target changes upstream, \`doctor\` catches it, the running client degrades that tool within one reload, and the proposed patch restores it after review.

M3 — Own it and automate it (3 weeks).  
WO-012, WO-013, packaging, Windows.

5.2 GOLDEN PATH

  recon start                                  \# recond up, extension connects  
  recon bundle && open recon.mcpb              \# once, ever — Claude Desktop  
  recon mcp add \--agent claude-code            \# once, ever — Claude Code

  \# click record in the extension, do the workflow, annotate, stop  
  recon studio                                 \# infer, review, approve  
  \# → tools are live in Claude Desktop within seconds; no reinstall

  recon doctor jira                            \# later: has the target drifted?  
  recon eject jira \--out ./jira-tools          \# optional: an artifact you own

5.3 OPEN QUESTIONS

Q1. Does incur support re-registering tools mid-session and emitting \`listChanged\`? ADR-005 depends on it. Spiked in M0; the fallback is a thin wrapper that re-emits \`tools/list\` on reload.  
Q2. How does Claude Desktop behave with a wide tool surface? Claude Code has tool search on by default, which absorbs it; Desktop is unverified. If it degrades, the \`enabled\` flag is the mitigation and named profiles become the next step (ADR-007).  
Q3. Description generation is a model call over redacted payloads, which conflicts with local-first unless a local model is used. Is a local model good enough to hold the 90% bar?  
Q4. Is relay latency acceptable for agent loops making many sequential calls? The 150 ms target is a guess until WO-009 measures it; if worse, relay-call batching becomes necessary.  
Q5. Does MAIN-world interception hold up on real targets, or do CSP and page-side hardening push more sessions onto the debugger path than expected? Test three real targets before WO-001 locks the strategy.  
Q6. Should recipes be portable between machines given that fixtures and base URLs are environment-specific? Leaning toward per-target config overlays rather than making the recipe environment-aware.