# epost-mcp

MCP server for the Swiss **ePost** digital letterbox ([app.epost.ch](https://app.epost.ch)) — list and download your scanned letters (Scanning-Service) from any MCP client.

ePost has **no public retrieval API** for private customers (the [public APIs](https://developer.epost.ch/) cover sending only). This server therefore drives the web portal with Playwright browser automation. It is inherently fragile: portal updates can break it, and it depends on your interactive SwissID login.

## How it works

- A persistent Chromium profile (`~/.epost-mcp/profile`) keeps the SwissID/ePost session between runs.
- When the session has expired, the `epost_login` tool opens a **visible** browser window; you complete the SwissID login (incl. 2FA) yourself. Everything else runs headless.
- Downloads go through the portal's own download button — no undocumented token endpoints.

## Tools

| Tool | Purpose |
| --- | --- |
| `epost_status` | `ok` or `login_required` |
| `epost_login` | opens a visible window for the SwissID login (waits up to 8 min) |
| `epost_list_letters` | index, sender, title, dates of every letter in the letterbox |
| `epost_download_letter` | download one letter (`index`, `output_dir`) |
| `epost_download_all` | download everything to `output_dir` |

## Install

```bash
git clone git@github.com:sapn95/epost-mcp.git
cd epost-mcp
npm install
npx playwright install chromium   # skip if a playwright chromium is already cached
```

Register with your MCP client, e.g. Claude Code:

```bash
claude mcp add --scope user epost -- node /path/to/epost-mcp/index.js
```

## Env

| Variable | Default | Purpose |
| --- | --- | --- |
| `EPOST_PROFILE` | `~/.epost-mcp/profile` | browser profile dir (holds the session — treat as secret) |
| `EPOST_CHROMIUM` | auto-detect | chromium executable override |

## Caveats

- Private use for your own letterbox. Respect ePost's terms of service.
- The profile directory contains live session cookies — never commit or share it.
- JSF component ids in the portal are unstable; selectors use CSS classes and labels with fallbacks, but expect occasional breakage after ePost releases.
- **SwissID uses session cookies**, so a session does not always survive a browser restart — expect to run `epost_login` at the start of a session. Within one running server instance the session stays warm across calls.
