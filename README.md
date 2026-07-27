# epost-mcp

[![npm](https://img.shields.io/npm/v/epost-mcp?logo=npm)](https://www.npmjs.com/package/epost-mcp)
[![CI](https://github.com/sapn95/epost-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sapn95/epost-mcp/actions/workflows/ci.yml)

> **Unofficial, and inherently fragile.** This drives a web portal with a real
> browser because the service offers no retrieval API. Portal updates break
> selectors without warning, and a broken selector means a failed run rather
> than a wrong result. It is published because it is useful, not because it is
> guaranteed — pin a version, read the errors, and expect to update. Use it for
> **your own** account and respect the provider's terms of service.

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

## Transport: the public API, with the browser as fallback

ePost publishes a REST API for the Digital Letterbox, and **a private tenant can
use it** — which is easy to miss, because the developer portal is written for
business clients. The API is preferred for everything it covers; browser
automation runs only when it cannot serve a call.

Set it up once:

1. Log in to app.epost.ch with SwissID as usual.
2. In the **same browser**, open `https://login.epost.ch/auth/realms/klara/account/`
   → *Authentication* → *Set/update password*, and set one. A SwissID login has
   no password of its own, which is the whole point of this step.
3. Store it: `security add-generic-password -a epost -s epost-mcp-api-password -w '<password>' -U`
   (or set `EPOST_API_PASSWORD`). The account e-mail comes from the same place as
   before.

Documented at
[How to access the letterbox public APIs with a private tenant](https://developer.epost.ch/docs/api-docs/v6nqmmjkxcery-how-to-access-the-letterbox-public-ap-is-with-a-private-tenant).

### Why it is worth it

Measured against the same account:

| | Browser | API |
| --- | --- | --- |
| List the inbox | tens of seconds, needs a live session | ~2s, no session at all |
| What a letter says | `Gescannter Brief` for every scan | a real `description` ("Invoice from …") and `documentTypes` |
| Storage listing | 48 cards at a time, scrolled | every document in one call |
| Archiving | two-step folder sheet | one `PATCH` |

That second row is the one that matters: the portal renders every scan with the
same title, so an archived document could not be classified without opening it.
The API has carried the sender all along.

### What the API does not do

There is **no endpoint to move a document that is already in Storage** between
folders. `PATCH /letters/{id}/archive` is inbox → folder only and answers `400`
for anything already archived — the documentation says so explicitly. Re-filing
therefore falls back to the browser.

A useful division follows from that: **the browser acts, the API verifies.**
After a browser move, the API reports exactly which document id ended up in
which folder — which matters because Storage cards show only a date, and dates
repeat.

### Auth model

```
POST /core/latest/tenants   {username, password}                     -> tenant_id, company_id
POST /core/latest/token     {username, password, grant_type=password,
                             tenant_id, company_id}                  -> access_token (600s)
GET  /epost/v2/letters      Authorization: Bearer …
```

The server re-authenticates a minute before expiry rather than tracking refresh
tokens: the password is already at hand, so a refresh buys nothing.

## Login: one fingerprint, nothing else

`epost_login` drives every step of the SwissID chain that does not need a human
and stops at the only one that does — the biometric prompt:

```
app.epost.ch → login.epost.ch     clicks "Login mit SwissID"
             → login-email         fills your account e-mail, "Weiter"
             → confirm-passkey     "Weiter"   → macOS asks for Touch ID   ← you
             → app.epost.ch, authenticated; session cached
```

Measured end to end: **19 seconds**, one fingerprint, no password and no SMS
code. Two things have to be in place:

1. **A passkey on your SwissID account**, created normally in Safari or Chrome
   (`account.swissid.ch` → Login-Einstellungen). Apple's authenticator is
   accepted; see the note below for why a software one is not.
2. **A signed browser.** Playwright's bundled Chromium is an unsigned test build
   and reports `isUserVerifyingPlatformAuthenticatorAvailable() === false`, so
   Touch ID is never offered and SwissID falls back to password + SMS. Installed
   Google Chrome reports `true`. The server therefore prefers a signed system
   browser automatically — `chrome`, `chrome-canary`, `edge`, `brave`, in that
   order — and falls back to the bundled Chromium. Override with `EPOST_BROWSER`.

Tell it which account to fill in, either way:

```bash
security add-generic-password -a epost -s epost-mcp-swissid-user \
  -w 'you@example.com' -U          # or: export EPOST_SWISSID_USER=you@example.com
```

`epost_settings` prints what was resolved — browser, passkey capability, paths,
and whether the account e-mail is configured. Run it first if a login surprises
you.

### Why the login cannot be fully unattended

The tempting idea is a *software* passkey via Chrome's WebAuthn virtual
authenticator, so the server could sign the login itself. That mechanism works
in general — verified end to end against a local relying party — but SwissID
rejects it, and says so plainly:

```
POST /api-login/authenticate/webauthn-register  ->  400
ERROR::WebauthnVendorNotAllowed: This webauthn passkey authenticator vendor is not allowed by SwissID
```

SwissID requests attestation and checks the authenticator's **AAGUID** (its
vendor id) against an allow-list of approved hardware makers. The credential was
created successfully on all six attempts; the server refused every one. Getting
past that would mean forging an approved vendor's identity, which is precisely
the control being enforced, so this project does not attempt it.

A real Touch ID passkey cannot be automated either: a platform authenticator
requires genuine user presence, by design. Hence the split above — automate all
of it except the fingerprint. `epost_passkey_register` / `_status` / `_forget`
remain for relying parties that do accept software authenticators, and
registration only reports success once the server has stored the credential.

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
| `epost_login` | `wait_seconds` (optional, default 300) | Opens a visible window and drives the SwissID chain up to the Touch ID prompt. `{ status, browser, message }` |
| `epost_settings` | — | Resolved browser + why, Touch ID capability, paths, whether the account e-mail is set |
| `epost_passkey_status` | — | `{ passkey: "enrolled" \| "none", rpId, signCount }` |
| `epost_passkey_register` | — | **One-time.** Opens a visible window with a virtual FIDO2 authenticator. Returns `rejected` against SwissID — see the passkey section. |
| `epost_passkey_forget` | — | Deletes the locally stored passkey. `{ removed }` |
| `epost_list_letters` | — | Array of `{ index, sender, title, dates, preview }` (newest first) |
| `epost_download_letter` | `index` (number), `output_dir` (string) | `{ saved }` — path of the saved `YYYY-MM-DD_ePost_<index>.pdf` |
| `epost_download_all` | `output_dir` (string) | `{ count, saved[] }` — every letter downloaded |
| `epost_store_letter` | `folder` (required); `index` or `title` | **Archive**: takes the letter out of the inbox into that Storage folder. Not a delete. `{ stored, folder }` |
| `epost_list_storage` | — | `{ folders: [{ name, count }], myDocuments, url }` — your **Custom** folders + the My-Documents count |
| `epost_list_storage_documents` | `scroll_all` (bool, optional) | `{ count, documents: [{ index, date, storedIn, preview }] }` — pass `scroll_all:true` to lazy-load every card |
| `epost_read_storage_document` | `index` or `title`; `output_dir` (optional) | Opens one Storage document: real sender/subject, document type, date, amount, folder — and saves the PDF when `output_dir` is given. The only way to classify an archived document, since the card list only ever says "Gescannter Brief". |
| `epost_create_folder` | `name` (string) | `{ created }` |
| `epost_move_to_folder` | `folder` (required); `index` or `title`; `remove_from` (optional) | Files a Storage document into a folder. `remove_from` unticks the old folder in the same sheet — the only way to empty one. |
| `epost_unfile_from_folder` | `folder` (required); `index` or `title` | Removes a folder membership. Only works while the document is in more than one folder (see below). |

### Notes on the Storage tools

The Storage area (`LetterStorage`) has auto **Companies** folders (grouped by
sender, e.g. ePost / la Mobilière), your **Custom** folders, and the master
**My Documents (N)** list. `epost_list_storage` returns your Custom folders and
the My-Documents count; `epost_list_storage_documents` enumerates the individual
documents (each only exposes a date + a `Stored in <folder>` tag once filed).

### Archiving a letter (`epost_store_letter`)

`Store` in the card menu is a **two-step** action: it opens a *Select a folder*
sheet carrying its own Store button, greyed out until a folder is ticked. That is
why a folder argument is required — without one the sheet cannot commit, and
stopping after the first click archives nothing while leaving an invisible
overlay that swallows every later click.

Three things inside that sheet make a folder that is plainly there look absent,
all of them handled now but worth knowing if it ever regresses:

- `.brand-container` also matches the letter cards *behind* the sheet, so the
  lookup has to be scoped to the sheet element.
- The tiles sit in a horizontally scrolling strip, so filtering on visibility
  drops every folder off to the right.
- Folder names must be compared **NFC-normalised**: a name with an umlaut is NFC
  on one side and NFD on the other, and a byte-exact compare never matches.

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

## Releasing

Published from CI with **npm Trusted Publishing** (OIDC) — there is no npm token
anywhere: no secret to store, rotate or leak. npm recommends this over an
automation token, and is restricting tokens that bypass 2FA.

One-time setup per package, on npmjs.com -> the package -> Settings ->
Trusted Publisher:

| Field | Value |
| --- | --- |
| Organization or user | sapn95 |
| Repository | epost-mcp |
| Workflow filename | release.yml |
| Allowed actions | npm publish |

The workflow filename must match exactly. That is deliberate: it stops any other
workflow in the repo from publishing under your name.

Then every release is one command:

    npm version patch && git push --follow-tags

The tag triggers the release workflow: it upgrades npm (trusted publishing needs
>= 11.5.1 and Node >= 22.14), refuses a tag whose version disagrees with
package.json, runs the gate, and publishes with a signed provenance statement.

### If the publish fails with 404

    npm notice publish Signed provenance statement ... from GitHub Actions
    npm error 404 Not Found - PUT https://registry.npmjs.org/epost-mcp

Provenance was signed, so OIDC worked — the registry simply does not accept this
workflow as a publisher yet. That means the **trusted publisher is not configured**,
or the repository / workflow name does not match. npm answers 404 rather than 403
so as not to reveal whether the package exists. It is not a credential problem:
there is no credential, by design.

## Checks

    npm test

Runs exactly what CI runs, offline and without credentials: a syntax check, the
protocol smoke test and the hygiene scan.

The smoke test completes the MCP handshake over stdio and asserts the things that
have actually broken here — a server version drifting from package.json, a tool
in the dispatcher but missing from the tool list (or advertised and unhandled), a
required property absent from a schema, and descriptions too thin to choose a
tool from. The hygiene scan refuses secrets, tracked session files and personal
identifiers.

## License

MIT © sapn95 — see [LICENSE](LICENSE).
