# epost-mcp

An [MCP](https://modelcontextprotocol.io) server for the Swiss **ePost** digital
letterbox ([app.epost.ch](https://app.epost.ch)). It lets an MCP client (Claude
Code, Claude Desktop, …) **list and download your scanned letters** and do basic
housekeeping in the ePost **Storage** area — folders and moving documents.

ePost has **no public retrieval API** for private customers (the
[public APIs](https://developer.epost.ch/) cover *sending* only). This server
therefore drives the web portal with Playwright browser automation. That makes it
inherently fragile: portal updates can break selectors, and it depends on your
interactive SwissID login. Use it for **your own** letterbox and respect ePost's
terms of service.

## Prerequisites

- **Node.js ≥ 18**
- A Chromium managed by Playwright
- A Swiss **ePost** account with the Scanning-Service, reachable via **SwissID**

```bash
git clone https://github.com/sapn95/epost-mcp.git
cd epost-mcp
npm install
npx playwright install chromium   # downloads the browser Playwright drives
```

## Session / login model

The hard part of ePost automation is the login. This server keeps you logged in
so you do **not** re-authenticate on every call or every restart:

- The SwissID/ePost session is cached as a Playwright **storageState** file at
  `~/.epost-mcp/state.json` (49 cookies incl. the KLARA/Keycloak SSO cookies).
- On startup the server loads that file, so a previously logged-in session is
  reused **across server restarts**.
- After a successful `epost_login` **and after every successful tool call**, the
  server re-saves `state.json`, keeping the cached session fresh.
- `epost_login` opens a **visible** (headed) browser window so you complete the
  SwissID login (incl. 2FA) yourself. Every other tool runs **headless**.
- SwissID sessions are short-lived. When the session expires, tools return
  `login_required` — just run `epost_login` again.

First-time / after-expiry flow:

1. Call `epost_status`. If it returns `login_required`…
2. …call `epost_login`. A browser window opens on app.epost.ch. Complete the
   SwissID login until you see your dashboard / the letterbox. The session is
   then cached to `~/.epost-mcp/state.json`.
3. Use `epost_list_letters`, `epost_download_letter`, etc. headlessly.

> **Security:** `~/.epost-mcp/state.json` contains **live session cookies** for
> your ePost/SwissID account. Treat it like a password. It is **git-ignored** in
> this repo and must **never** be committed, shared, or synced to a cloud folder.
> Delete it to force a fresh login. Override its location with `EPOST_STATE`.

## Passkey: does NOT work against SwissID (tested)

The idea was to remove the interactive login entirely by enrolling a **software
passkey** through Chrome's WebAuthn *virtual authenticator* (CDP) and signing
the login automatically. The mechanism itself works — it was verified end to end
against a local relying party: key created, private key exported, and a brand
new browser context signed a valid assertion with no user interaction.

**SwissID refuses it**, and says exactly why. Its registration page asks for

```json
{ "attestation": "indirect",
  "authenticatorSelection": { "userVerification": "required", "requireResidentKey": true } }
```

the key is created fine every time, and then the server answers:

```
POST /api-login/authenticate/webauthn-register  ->  400
ERROR::WebauthnVendorNotAllowed: This webauthn passkey authenticator vendor is not allowed by SwissID
```

So SwissID validates the attestation's **AAGUID** — the authenticator's vendor
id — against an allow-list of approved hardware makers. A virtual authenticator
is not on that list. Getting past it would mean forging a listed vendor's
identity, which is precisely the control being enforced; this project does not
attempt that.

Note also that a *real* Touch ID passkey does not help either: a platform
authenticator requires genuine user presence, which an automated browser cannot
provide. So for ePost the answer is simply: **log in interactively once, and let
the cached session do the rest** — which is what the session model above does.

`epost_passkey_register` / `_status` / `_forget` are kept for relying parties
that do accept software authenticators. Registration only reports success once
the server has actually stored the credential; a local key alone is never
treated as success (that mistake produced a convincing false positive).

## Register in Claude Code

Use an **absolute** path to `index.js`:

```bash
claude mcp add epost --scope user -- node /absolute/path/to/epost-mcp/index.js
```

Or add it directly to `~/.claude.json`:

```json
{
  "mcpServers": {
    "epost": {
      "command": "node",
      "args": ["/absolute/path/to/epost-mcp/index.js"]
    }
  }
}
```

(Claude Desktop uses the same shape in its `claude_desktop_config.json`.)

## Tools

| Tool | Params | Returns |
| --- | --- | --- |
| `epost_status` | — | `{ status: "ok" \| "login_required" }` |
| `epost_login` | — | Opens a visible window for the SwissID login (waits up to 8 min), then caches the session. `{ status, message }` |
| `epost_passkey_status` | — | `{ passkey: "enrolled" \| "none", rpId, signCount }` |
| `epost_passkey_register` | — | **One-time.** Opens a visible window with a virtual FIDO2 authenticator. Returns `rejected` against SwissID — see the passkey section. |
| `epost_passkey_forget` | — | Deletes the locally stored passkey. `{ removed }` |
| `epost_list_letters` | — | Array of `{ index, sender, title, dates, preview }` (newest first) |
| `epost_download_letter` | `index` (number), `output_dir` (string) | `{ saved }` — path of the saved `YYYY-MM-DD_ePost_<index>.pdf` |
| `epost_download_all` | `output_dir` (string) | `{ count, saved[] }` — every letter downloaded |
| `epost_list_storage` | — | `{ folders: [{ name, count }], myDocuments, url }` — your **Custom** folders + the My-Documents count |
| `epost_list_storage_documents` | `scroll_all` (bool, optional) | `{ count, documents: [{ index, date, storedIn, preview }] }` — pass `scroll_all:true` to lazy-load every card |
| `epost_create_folder` | `name` (string) | `{ created }` |
| `epost_move_to_folder` | `folder` (string, required); `index` (number) or `title` (substring) | `{ moved }` or `{ already_in_folder: true }` — files the document into the folder |

### Notes on the Storage tools

The Storage area (`LetterStorage`) has auto **Companies** folders (grouped by
sender, e.g. ePost / la Mobilière), your **Custom** folders, and the master
**My Documents (N)** list. `epost_list_storage` returns your Custom folders and
the My-Documents count; `epost_list_storage_documents` enumerates the individual
documents (each only exposes a date + a `Stored in <folder>` tag once filed).

**ePost folders are additive labels, not physical locations.** *My Documents*
always lists every document; filing simply adds a folder membership (a document
can belong to several folders at once). `epost_move_to_folder` reflects this: it
opens the document's `…` menu → *Move* → ticks the target folder → confirms, and
is **idempotent** — a no-op if the document is already in that folder, and it
never removes an existing membership. Two consequences worth knowing:

- Filing bumps a document to the top of the *Last used* order, so **re-list
  before addressing the next document by `index`** (indices shift after a move).
- The portal's *Move* sheet will not commit an **empty** folder set, so a
  document that is in exactly one folder cannot be returned to "unfiled" through
  this flow — you can only re-file it elsewhere (or delete it) in the ePost UI.
  In other words, **filing is effectively one-way**; get the target right first.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `EPOST_STATE` | `~/.epost-mcp/state.json` | Cached session (storageState). **Secret.** |
| `EPOST_CHROMIUM` | auto-detect | Path to the Chromium executable to drive |

The Chromium path is auto-detected from the Playwright cache
(`~/Library/Caches/ms-playwright/chromium-*`). Set `EPOST_CHROMIUM` only if
auto-detection fails.

## Troubleshooting

- **Tools return `login_required`.** The cached session expired (SwissID sessions
  are short-lived). Run `epost_login` and complete SwissID; the session is
  re-cached. If it keeps happening immediately, delete `~/.epost-mcp/state.json`
  and log in fresh.
- **`epost_login` window never appears.** `epost_login` is the only tool that
  runs headed. If nothing opens, another instance may hold the browser — stop
  other MCP clients using this server, then retry.
- **Chromium not found.** Run `npx playwright install chromium`, or set
  `EPOST_CHROMIUM` to the executable path, e.g. on macOS:
  `~/Library/Caches/ms-playwright/chromium-<build>/chrome-mac/Chromium.app/Contents/MacOS/Chromium`.
- **Download does not trigger.** The server clicks the portal's **Download File**
  button and captures the browser download event. If it times out, ePost likely
  changed the letter-detail layout; the button is matched by its visible text and
  `[aria-label="Download File"]`. Re-run `epost_list_letters` first to confirm the
  letterbox is reachable.
- **Selectors broke after an ePost release.** This automation tracks the live DOM
  (`div.letter-wrapper`, *Digital Letterbox*, *Go to Storage*, *Download File*).
  Portal changes can break it; open an issue.

## How it works (internals)

1. `chromium.launch({ headless })` + `browser.newContext({ storageState })` load
   the cached cookies. `acceptDownloads: true`, `locale: 'de-CH'`.
2. Navigating to `app.epost.ch` follows the KLARA/SwissID SSO redirect chain onto
   the dashboard (or a visible login form if the session died).
3. The letterbox is opened by clicking the **Digital Letterbox** label
   (URL then contains `DigitalLetterboxOverview`).
4. Letters are `div.letter-wrapper` elements. Downloads iterate on the same page:
   click letter → **Download File** → save → **Escape** back to the list.

## License

MIT © sapn95 — see [LICENSE](LICENSE).
