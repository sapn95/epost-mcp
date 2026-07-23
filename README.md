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
| `epost_list_letters` | — | Array of `{ index, sender, title, dates, preview }` (newest first) |
| `epost_download_letter` | `index` (number), `output_dir` (string) | `{ saved }` — path of the saved `YYYY-MM-DD_ePost_<index>.pdf` |
| `epost_download_all` | `output_dir` (string) | `{ count, saved[] }` — every letter downloaded |
| `epost_list_storage` | — | `{ folders: [{ name, count }], myDocuments, url }` |
| `epost_create_folder` | `name` (string) | `{ created }` |
| `epost_move_to_folder` | `folder` (string, required); `index` (number) or `title` (substring) | `{ moved, note }` — **experimental**, see below |

### Notes on the Storage tools

The Storage area (`LetterStorage`) has auto **Companies** folders (grouped by
sender), your **Custom** folders, and an unsorted **My Documents (N)** bucket.
`epost_list_storage` and `epost_create_folder` read/drive the documented layout.

`epost_move_to_folder` is **experimental**: it opens a document's `…` (three-dots)
menu, chooses *Move*, and picks the target folder by name. The exact move dialog
DOM can change between portal releases, so **verify the result in the ePost UI**
after calling it. Identify the document by `index` (position in Storage) or by a
`title` substring.

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
