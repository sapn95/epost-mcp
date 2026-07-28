#!/usr/bin/env node
// epost-mcp — MCP server for the Swiss ePost digital letterbox (app.epost.ch).
//
// ePost offers no public retrieval API for private customers, so this server
// drives the web portal with Playwright. The SwissID session is cached as a
// Playwright storageState file so it survives server restarts; when it expires,
// call `epost_login` and complete SwissID interactively in the opened window.
//
// Env:
//   EPOST_STATE     storageState json path  (default: ~/.epost-mcp/state.json)
//   EPOST_PROFILE   persistent browser profile (default: ~/.epost-mcp/profile)
//   EPOST_BROWSER   chrome | chrome-canary | edge | brave | chromium | abs. path
//   EPOST_SWISSID_USER  account e-mail (or keychain epost-mcp-swissid-user)
//   EPOST_TRANSPORT auto (default) | api | browser
//   EPOST_API_PASSWORD  API password (or keychain epost-mcp-api-password)
//   EPOST_API_KEY       X-API-KEY (or keychain epost-mcp-api-key) — alternative
//                       to the password grant, or sent alongside it
//   EPOST_DEBUG     1 = trace the login steps on stderr

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync, readFileSync, rmSync, chmodSync, openSync, writeSync, fchmodSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Name and version come from package.json, never from a second copy here:
// `npm version` only bumps package.json, so a hardcoded string silently
// advertises a stale version to every client.
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const STATE = process.env.EPOST_STATE || join(homedir(), '.epost-mcp', 'state.json');
const PROFILE = process.env.EPOST_PROFILE || join(homedir(), '.epost-mcp', 'profile');
// Overridable so the portal automation can be driven against a local fixture in
// tests — the selector logic is where every browser bug has been.
const APP_URL = process.env.EPOST_APP_URL || 'https://app.epost.ch';

// --- browser bootstrap ------------------------------------------------------

// Which browser to drive. This matters for more than taste: Playwright's own
// Chromium is an unsigned test build with no access to the macOS platform
// authenticator — it reports isUserVerifyingPlatformAuthenticatorAvailable()
// === false, so Touch ID is never offered and SwissID falls back to password
// plus SMS. An installed, signed browser reports true and can reach the Secure
// Enclave, which is what makes the assisted passkey login possible.
const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chrome-canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};
const BROWSER_ORDER = ['chrome', 'chrome-canary', 'edge', 'brave'];

// What we settled on and why — reported by epost_settings.
let browserChoice = { path: undefined, key: null, reason: '' };

function findChromium() {
  const pick = (path, key, reason) => { browserChoice = { path, key, reason }; return path; };

  // 1. Explicit choice: a key from BROWSERS, or an absolute path.
  const want = process.env.EPOST_BROWSER || process.env.EPOST_CHROMIUM;
  if (want && want !== 'chromium') {
    const path = BROWSERS[want] || want;
    if (!existsSync(path)) throw new Error(`EPOST_BROWSER="${want}" not found (looked at ${path})`);
    return pick(path, BROWSERS[want] ? want : 'custom', 'EPOST_BROWSER');
  }
  // 2. Otherwise prefer a signed system browser, so passkeys stay possible.
  if (!want) {
    for (const key of BROWSER_ORDER) {
      if (existsSync(BROWSERS[key])) return pick(BROWSERS[key], key, 'signed system browser (passkey-capable)');
    }
  }
  // 3. Fall back to Playwright's Chromium: fine for everything but passkeys.
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return pick(p, 'chromium', 'bundled Chromium — no Touch ID support');
  } catch { /* fall through to cache scan */ }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter(n => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = join(cache, d, rel);
        // Recorded like every other branch: returning the path without it left
        // epost_settings reporting that no browser had been resolved while one
        // was already driving the portal.
        if (existsSync(p)) return pick(p, 'chromium', 'Playwright cache — no Touch ID support');
      }
    }
  }
  return undefined; // let playwright resolve (may need `npx playwright install chromium`)
}

let browserObj = null;
let ctx = null;
let headed = false;

// Re-seed a fresh context from the cached storageState. A persistent profile
// drops session cookies when the browser closes, so the two mechanisms cover
// different halves of the problem — see getContext.
async function seedFromState(c) {
  if (!existsSync(STATE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE, 'utf8'));
    if (saved.cookies?.length) await c.addCookies(saved.cookies).catch(() => {});
  } catch { /* a corrupt state file just means "log in again" */ }
}

// One launch at a time. Tool calls can arrive together, and two
// launchPersistentContext calls against the same profile collide on Chrome's
// ProcessSingleton: one of them fails outright, and the stale-lock retry below
// then deletes the lock the other one is legitimately holding. Callers that
// arrive during a launch wait for it instead of starting their own.
let ctxPending = null;

async function getContext(wantHeaded = false) {
  // Reuse an existing context unless we specifically need a headed one but only
  // have a headless one (the interactive login case).
  if (ctx && (!wantHeaded || headed)) return ctx;
  if (ctxPending) {
    await ctxPending.catch(() => {});
    if (ctx && (!wantHeaded || headed)) return ctx;
  }
  ctxPending = openContext(wantHeaded).finally(() => { ctxPending = null; });
  return ctxPending;
}

async function openContext(wantHeaded) {
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  if (browserObj) { await browserObj.close().catch(() => {}); browserObj = null; }

  // A PERSISTENT profile plus the cached storageState, deliberately both:
  //   - the profile keeps everything a fresh context throws away, notably
  //     SwissID's "this device is known" state, so an expired session costs a
  //     password but not a fresh SMS code;
  //   - storageState carries the session cookies, which a persistent profile
  //     drops on close.
  // v0.3.0 replaced the profile with storageState alone, which is why every
  // expiry meant the full two-factor dance again.
  // The profile holds the same session, in Chromium's own store.
  mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
  try { chmodSync(PROFILE, 0o700); } catch { /* not ours to tighten */ }
  const launch = () => chromium.launchPersistentContext(PROFILE, {
    headless: !wantHeaded,
    executablePath: findChromium(),
    acceptDownloads: true,
    locale: 'de-CH',
    viewport: { width: 1400, height: 1000 },
  });
  try {
    ctx = await launch();
  } catch (e) {
    // A browser that was killed rather than closed leaves SingletonLock behind,
    // and Chrome then refuses to start at all ("Failed to create a
    // ProcessSingleton for your profile directory"). Every later call fails the
    // same way until the file goes, so clear the stale lock and retry once.
    if (!/ProcessSingleton|SingletonLock/.test(e.message || '')) throw e;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(join(PROFILE, f), { force: true }); } catch { /* nothing to clear */ }
    }
    ctx = await launch();
  }
  browserObj = null;              // a persistent context owns its browser
  await seedFromState(ctx);
  headed = wantHeaded;
  return ctx;
}

async function getPage(wantHeaded = false) {
  const c = await getContext(wantHeaded);
  const [existing] = c.pages();
  return existing ?? c.newPage();
}

// Playwright's nth(-1) means "the last one" and a negative array index is simply
// undefined, so a nonsense index quietly acted on a different document than the
// one asked for. An index that cannot be honoured is an error, not a guess.
function checkIndex(index, n, what) {
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new Error(`index ${index} out of range (${n} ${what})`);
  }
}

// Write bytes to a path the caller named, and only to a path.
//
// writeFileSync takes a number as a FILE DESCRIPTOR, so output_path: 2 wrote a
// letter to stderr and output_path: 1 wrote it into the MCP stream itself. It
// also follows a symlink at the destination, and mode: only applies to a file
// it creates — an existing world-readable file kept its permissions until the
// chmod afterwards. O_NOFOLLOW and an explicit 0600 close all three.
function writePrivate(path, bytes) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`output path must be a path, not ${typeof path}`);
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    // writeSync may write fewer bytes than it was given, and ignoring that
    // reported a truncated file as saved with the full byte count beside it.
    let off = 0;
    while (off < bytes.length) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (!n) throw new Error(`write stalled at ${off}/${bytes.length} bytes`);
      off += n;
    }
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

const oneByTitle = (items, title) => {
  const hits = items.filter(x => JSON.stringify(x).includes(title));
  if (hits.length > 1) throw new Error(`"${title}" matches ${hits.length} letters — address one by id or index instead`);
  return hits[0] || null;
};

// Resolve a document addressed by a text substring, and refuse to guess.
//
// Storage cards show only a date, and dates repeat; "the first card containing
// this text" therefore moved, read or archived a neighbour just as readily as
// the intended document. A substring that matches more than one thing is not
// an address.
async function cardByTitle(p, title) {
  const all = p.locator('div.letter-wrapper', { hasText: title });
  const n = await all.count();
  if (!n) throw new Error(`no document matching "${title}"`);
  if (n > 1) throw new Error(`"${title}" matches ${n} documents — address one by index instead`);
  return all.first();
}

// A file name is assembled from values the service supplies — a letter id, a
// date it reported. join() resolves "../" happily, so an id shaped like a path
// would write outside the directory the caller named. Keep name parts to
// characters that can only ever be a name.
const namePart = v => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || 'x';

// Persist cookies/localStorage so the session survives a server restart.
async function saveState() {
  if (!ctx) return;
  try {
    // A session cookie is password-equivalent: whoever reads this file is
    // logged in as the account. It was written with the process umask, which on
    // a normal machine means every local user could read it.
    mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
    chmodSync(dirname(STATE), 0o700);
    await ctx.storageState({ path: STATE });
    chmodSync(STATE, 0o600);
  } catch { /* best effort */ }
}

// --- credentials -----------------------------------------------------------
//
// A note on passkeys, because it looks like the obvious idea and is not: this
// server used to carry a WebAuthn *virtual authenticator* so it could sign the
// SwissID login itself, unattended. The mechanism works in general — but
// SwissID rejects software authenticators outright:
//
//   POST /api-login/authenticate/webauthn-register -> 400
//   ERROR::WebauthnVendorNotAllowed
//
// It was removed rather than kept "just in case". It could never work against
// the one service this server talks to, it was never exercised, and it wrote an
// exportable private key into the login keychain — a standing risk in exchange
// for nothing. A real Touch ID passkey cannot be automated either: a platform
// authenticator requires genuine user presence, by design. What remains is the
// assisted login, which drives everything except the fingerprint.

const DEBUG = !!process.env.EPOST_DEBUG;   // trace the login steps on stderr

function keychainRead(service, account = 'epost') {
  try {
    return execFileSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// An environment variable that is SET, even to the empty string, is the answer.
// Falling through to the keychain on an empty value makes it impossible to say
// "no credential" — and let a test that tried to isolate itself silently pick
// up the real account.
const envOrKeychain = (name, service) =>
  (process.env[name] !== undefined ? process.env[name] : keychainRead(service)) || '';

// --- public API (preferred transport) ---------------------------------------
//
// ePost publishes a documented REST API for the Digital Letterbox, and a private
// tenant can use it: set a password once on the Keycloak account
// (login.epost.ch/auth/realms/klara/account/ -> Authentication -> set password)
// and authenticate with e-mail + password. See
// https://developer.epost.ch/docs/api-docs/v6nqmmjkxcery-how-to-access-the-letterbox-public-ap-is-with-a-private-tenant
//
// This is strictly better than driving the portal: the listing carries a real
// `description` ("Invoice from ...") and `documentTypes` instead of the
// uniform "Gescannter Brief" the UI shows, archiving is one PATCH instead of a
// two-step folder sheet, and nothing depends on a selector. Browser automation
// remains as the fallback for whatever the API does not cover, and for when it
// is unavailable.
//
// Auth chain (both documented):
//   POST /core/latest/tenants  {username,password}                -> tenant_id, company_id
//   POST /core/latest/token    {username,password,grant_type=password,tenant_id,company_id}
//                                                                  -> access_token (600s)

const API_BASE = process.env.EPOST_API_BASE || 'https://api.epost.ch';
// The API documents TWO security schemes: an API key (X-API-KEY) and Bearer.
// Support both. A key alone is enough for the letterbox endpoints and skips the
// password grant entirely; when both are configured the key is sent alongside
// the token, which is what the portal's own examples do.
const KC_API_KEY = 'epost-mcp-api-key';
// auto (default) = API when it can serve the call, browser otherwise.
// Forcing one is for diagnosis and for the operations only the browser can do.
const TRANSPORT = (process.env.EPOST_TRANSPORT || 'auto').toLowerCase();
const KC_API_PASSWORD = 'epost-mcp-api-password';

let apiToken = null;          // { value, expiresAt, tenant }
let apiUnavailable = null;    // why the API cannot be used, once known

function apiKey() {
  if (TRANSPORT === 'browser') return '';
  return envOrKeychain('EPOST_API_KEY', KC_API_KEY);
}

function apiCredentials() {
  if (TRANSPORT === 'browser') return null;      // pinned to the browser
  const user = swissIdUser();
  const password = envOrKeychain('EPOST_API_PASSWORD', KC_API_PASSWORD);
  return user && password ? { user, password } : null;
}

// An upstream error body can be made of the request that produced it — a proxy
// echoing the Authorization header, a gateway quoting the form it rejected. The
// body reaches the model through a tool result, so anything we hold is stripped
// out of it first, in each shape it could have travelled in. The sister server
// has had this since it was written; this one had nothing.
function redact(s) {
  let out = String(s ?? '');
  const secrets = [
    process.env.EPOST_API_PASSWORD, process.env.EPOST_API_KEY,
    apiKey(), envOrKeychain('EPOST_API_PASSWORD', KC_API_PASSWORD),
    apiToken?.value,
  ];
  for (const v of secrets) {
    // Short values are left alone: mangling every occurrence of a four-character
    // string would make errors unreadable, and no real credential is that short.
    if (typeof v !== 'string' || v.length < 8) continue;
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])) {
      out = out.split(form).join('***');
    }
  }
  return out;
}

async function apiFetch(method, path, { params, form, json, token, raw } = {}) {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const key = apiKey();
  if (key) headers['X-API-KEY'] = key;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    // Redact first, cut second: truncating mid-credential leaves a fragment the
    // redactor no longer recognises.
    const detail = redact(await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`${method} ${path} -> ${res.status}${detail ? ` ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// A token lasts 600s. Re-authenticate slightly early rather than tracking the
// refresh token: the password is already at hand, so a refresh buys nothing.
async function apiAuth() {
  if (apiToken && Date.now() < apiToken.expiresAt) return apiToken.value;
  const creds = apiCredentials();
  if (!creds) {
    // An API key on its own is a complete credential — no password grant needed.
    if (apiKey()) { apiUnavailable = null; return 'api-key'; }
    apiUnavailable = 'no API credentials configured (keychain: epost-mcp-api-password or epost-mcp-api-key)';
    return null;
  }
  try {
    const tenants = await apiFetch('POST', '/core/latest/tenants',
      { form: { username: creds.user, password: creds.password } });
    const tenant = (Array.isArray(tenants) ? tenants : [tenants])[0];
    if (!tenant?.tenant_id) throw new Error('no tenant returned');
    const tok = await apiFetch('POST', '/core/latest/token', {
      form: {
        username: creds.user, password: creds.password, grant_type: 'password',
        tenant_id: tenant.tenant_id, company_id: tenant.company_id,
      },
    });
    apiToken = {
      value: tok.access_token,
      expiresAt: Date.now() + Math.max(30, (tok.expires_in || 600) - 60) * 1000,
      tenant,
    };
    apiUnavailable = null;
    if (DEBUG) console.error('[api] authenticated, expires_in', tok.expires_in);
    return apiToken.value;
  } catch (e) {
    apiUnavailable = e.message;
    if (DEBUG) console.error('[api] auth failed:', e.message);
    return null;
  }
}

// Run `fn` against the API; return null if the API cannot serve it, so the
// caller falls back to the browser instead of failing.
// Run `fn` against the API. Returns null when the API cannot serve the call at
// all, so the caller falls back to the browser.
//
// A 4xx is NOT that case: it is the API answering, and answering no. Treating
// "already archived" or "not found" as "unavailable" would silently retry the
// operation through the browser, where it may do something subtly different, or
// hand the caller a fallback result for a request the service rejected. Those
// are rethrown so the tool can report them. The exceptions are 401 (retry once
// with a fresh token) and 404, which can legitimately mean "not here".
async function withApi(fn) {
  const auth = await apiAuth();
  if (!auth) return null;
  const bearer = () => (apiToken ? apiToken.value : null);   // null when the key alone authenticates
  // A call that works is proof the API is reachable. Without this, one early
  // failure left epost_settings reporting the API unavailable for the life of
  // the process, long after it had recovered.
  const ok = v => { apiUnavailable = null; return v; };
  try {
    return ok(await fn(bearer()));
  } catch (e) {
    if (e.status === 401) {
      apiToken = null;
      if (await apiAuth()) {
        try { return ok(await fn(bearer())); } catch (e2) {
          // Same policy as below: an authoritative "no" is still a no on the
          // second attempt. Swallowing it as unavailability sent the caller to
          // the browser to do something the service had just refused.
          if (e2.status >= 400 && e2.status < 500 && e2.status !== 401 && e2.status !== 404) throw e2;
          apiUnavailable = e2.message;
          if (DEBUG) console.error('[api] retry failed:', e2.message);
          return null;
        }
      }
      apiUnavailable = e.message;
      return null;
    }
    if (e.status >= 400 && e.status < 500 && e.status !== 404) throw e;
    apiUnavailable = e.message;
    if (DEBUG) console.error('[api] call failed:', e.message);
    return null;
  }
}

// Shape one API letter like the browser tools report them, so both transports
// return the same thing to a client.
function apiLetterRow(l, i) {
  return {
    index: i,
    id: l.id,
    sender: l.description || null,          // "Invoice from <sender>" when known
    title: l.letterTitle || null,
    documentTypes: l.documentTypes || [],
    date: (l.receivedDateTime || '').slice(0, 10).split('-').reverse().join('.') || null,
    receivedDateTime: l.receivedDateTime || null,
    fileName: l.fileName || null,
    read: l.readStatus === 'READ',
    // null = in no folder; undefined = membership was not looked up
    storedIn: l.directoryNames ?? l.directoryName ?? undefined,
  };
}

const apiListLetters = (limit = 200) => withApi(t => apiFetch('GET', '/epost/v2/letters', {
  token: t, params: { 'letter-types': 'CLASSIC_LETTER', 'letter-folder': 'INBOX_FOLDER', limit },
}));

const apiListDirectories = () => withApi(t => apiFetch('GET', '/epost/v2/archives/directories', { token: t }));

const apiListArchive = (directoryId, limit = 1000) => withApi(t => apiFetch('GET', '/epost/v2/archives/letters', {
  token: t, params: { limit, 'directory-id': directoryId || undefined },
}));

// The archive listing carries NO folder field, so a document read from it looks
// unfiled even when it is not — which would have a caller re-file the whole
// archive. Membership has to be derived by asking each folder what it holds.
// One call per folder, and there are few of them.
async function apiArchiveWithFolders(limit = 1000) {
  const all = await apiListArchive(undefined, limit);
  if (!all) return null;
  const items = Array.isArray(all) ? all : (all.letters || all.content || []);
  const dirs = await apiListDirectories();
  if (!dirs) return items;
  const folders = new Map();
  // A folder that cannot be listed tells us nothing about what is in it. Folding
  // that into the same `null` as "in no folder" would report filed documents as
  // unfiled — and a caller acting on that would re-file the whole archive.
  let complete = true;
  for (const d of dirs.filter(x => x.directoryId)) {
    const inDir = await apiListArchive(d.directoryId, limit);
    if (inDir === null) { complete = false; continue; }
    // Same unwrapping as the archive listing above, `content` included: this
    // one accepted only `letters`, so a service answering with the wrapper the
    // other branch already handles reported every document as unfiled.
    for (const l of (Array.isArray(inDir) ? inDir : (inDir?.letters || inDir?.content || []))) {
      folders.set(l.id, [...(folders.get(l.id) || []), d.directoryName]);
    }
  }
  return items.map(l => ({
    ...l,
    // undefined = not looked up, as apiLetterRow already documents
    directoryNames: folders.get(l.id) ?? (complete ? null : undefined),
  }));
}

const apiLetterContent = id => withApi(t => apiFetch('GET', `/epost/v2/letters/${id}/content`, { token: t, raw: true }));

const apiArchiveLetter = (id, directoryId) => withApi(t => apiFetch('PATCH', `/epost/v2/letters/${id}/archive`, {
  token: t, params: { 'destination-directory-id': directoryId || undefined },
}).then(() => true));



// --- the rest of the letterbox API -----------------------------------------

const apiGetLetter = id => withApi(t => apiFetch('GET', `/epost/v2/letters/${id}`, { token: t }));

// Full-text search across the letters — something the portal never offered us.
const apiSearch = (q, where = 'ALL', limit = 50) => withApi(t => apiFetch('GET', '/epost/v2/letters/search', {
  token: t, params: { keyword: q, 'search-location': where, limit },
}));

const apiUnreadCount = () => withApi(t => apiFetch('GET', '/epost/v2/letters/inbox/count', { token: t }));

const apiSetRead = (ids, status) => withApi(t => apiFetch('POST', '/epost/v2/letters/read', {
  token: t, json: { letterIds: ids, readStatus: status },
}).then(() => true));

const apiDeletedLetters = () => withApi(t => apiFetch('GET', '/epost/v2/letters/deleted', { token: t }));

const apiRestoreLetter = id => withApi(t => apiFetch('POST', `/epost/v2/letters/${id}/restore`, { token: t }).then(() => true));

const apiDeleteLetter = id => withApi(t => apiFetch('DELETE', `/epost/v2/letters/${id}`, { token: t }).then(() => true));

const apiThumbnail = id => withApi(t => apiFetch('GET', `/epost/v2/letters/${id}/thumbnail`, { token: t, raw: true }));


// --- navigation helpers -----------------------------------------------------

// True when we are sitting on the ePost / SwissID login screen.
async function isLoginPage(p) {
  const u = p.url();
  if (/swissid\.ch|login\.epost\.ch/.test(u)) {
    if (await p.getByText('Login mit SwissID', { exact: false }).count()) return true;
    if (await p.locator('input[type="password"]').count()) return true;
  }
  return false;
}

// Navigate to the digital letterbox. Returns 'ok' or 'login_required'.
async function ensureLetterbox(p, timeout = 40000) {
  if (p.url().includes('DigitalLetterboxOverview') && await p.locator('div.letter-wrapper').count()) {
    return 'ok';
  }
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  // Let the SwissID/KLARA SSO redirect chain settle onto the dashboard (or a
  // visible login form if the cached session has expired).
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(1500);
    if (await isLoginPage(p)) return 'login_required';
    const u = p.url();
    if (/app\.epost\.ch/.test(u) && !/oauth_login|openid-connect/.test(u)) break;
  }
  if (await isLoginPage(p)) return 'login_required';

  // Open the letterbox from the dashboard by clicking its visible label.
  const dl = p.getByText('Digital Letterbox', { exact: false }).first();
  if (await dl.count()) await dl.click({ timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    if (p.url().includes('DigitalLetterboxOverview')) return 'ok';
    if (await p.locator('div.letter-wrapper').count()) return 'ok';
    if (await isLoginPage(p)) return 'login_required';
    await p.waitForTimeout(1500);
  }
  return p.url().includes('DigitalLetterboxOverview') ? 'ok' : 'login_required';
}

async function listLetters(p) {
  // An empty letterbox has no cards, and waiting for one used to mean twenty
  // seconds followed by a thrown timeout — an inbox with nothing in it reported
  // as a failure. Waiting is still right when cards are on their way, so give
  // up quietly and let the extraction return nothing.
  await p.waitForSelector('div.letter-wrapper', { timeout: 20000 }).catch(() => {});
  return p.$$eval('div.letter-wrapper', els => els.map((el, i) => {
    const pick = sel => { const n = el.querySelector(sel); return n ? n.innerText.replace(/\s+/g, ' ').trim() : ''; };
    const dates = [...el.innerText.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map(m => m[0]);
    return {
      index: i,
      sender: pick('.sender-name'),
      title: pick('.letter-title-name'),
      // The API row reports a single `date`, and apiLetterRow claims the two
      // transports hand a client the same thing. They did not: this side only
      // ever exposed the raw list, so a client that fell back to the browser
      // read `undefined` from a field that worked a moment earlier. A card can
      // show more than one date, so both are reported — the first is the one
      // printed next to the sender.
      date: dates[0] || null,
      dates,
      preview: el.innerText.replace(/\s+/g, ' ').slice(0, 120),
    };
  }));
}

// Click the nth letter, hit "Download File", capture the download, save it, and
// press Escape to return to the list. Stays on the same page (no re-goto of the
// per-session DigitalLetterboxOverview dialog URL, which breaks between letters).
async function downloadLetter(p, index, outputDir, meta) {
  mkdirSync(outputDir, { recursive: true });
  const wrappers = p.locator('div.letter-wrapper');
  const n = await wrappers.count();
  checkIndex(index, n, 'letters');
  await wrappers.nth(index).click();
  await p.waitForTimeout(3500);

  const byAria = p.locator('[aria-label="Download File"]').first();
  const byText = p.getByText('Download File', { exact: false }).first();
  const target = (await byAria.count()) ? byAria : byText;
  if (!(await target.count())) {
    await p.keyboard.press('Escape').catch(() => {});
    throw new Error('"Download File" button not found in the letter detail');
  }

  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 20000 }),
    target.click({ timeout: 10000 }),
  ]);
  const date = meta?.dates?.[0];
  const stamp = date ? date.split('.').reverse().join('-') : 'undated';
  const saved = join(outputDir, `${namePart(stamp)}_ePost_${namePart(index)}.pdf`);
  await dl.saveAs(saved);
  try { chmodSync(saved, 0o600); } catch { /* the download may live elsewhere */ }

  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(1500);
  return saved;
}

// --- storage (organized area) ----------------------------------------------

// Navigate from the letterbox into the Storage view (URL contains LetterStorage).
async function goToStorage(p) {
  const st = await ensureSession(p);
  if (st !== 'ok') return st;
  if (!p.url().includes('LetterStorage')) {
    const gs = p.getByText('Go to Storage', { exact: false }).first();
    if (await gs.count()) await gs.click({ timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      if (p.url().includes('LetterStorage')) break;
      await p.waitForTimeout(1500);
    }
  }
  // The loop above gives up quietly after eighteen seconds, and every caller
  // then read whatever page it was left on — inbox cards reported as Storage
  // documents, or an empty folder list reported as "no folders".
  if (!p.url().includes('LetterStorage')) return 'storage_unreachable';
  return 'ok';
}

// List the (custom) folder tiles and the unsorted "My Documents (N)" count.
// Folder tiles render their name followed by an "N Files" badge; the branded
// "Companies" folders (ePost / la Mobilière) show a logo instead of a text name
// and are therefore not returned here — only the user's own move targets are.
async function listStorage(p) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2500);
  const data = await p.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const folders = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 5) continue;
      const t = clean(el.innerText);
      const m = t.match(/^(.{1,40}?)\s+(\d+)\s+Files?$/);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || /Files|^\d+$|\(\d+\)/.test(name)) continue; // skip mashed/branded tiles
      const key = name + '|' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      folders.push({ name, count: Number(m[2]) });
    }
    const body = clean(document.body.innerText);
    const my = body.match(/My Documents\s*\((\d+)\)/i);
    // Origin and path only: the portal carries per-session instance ids in the
    // query string, and a tool result goes straight into the model's context.
    return { url: location.origin + location.pathname, myDocuments: my ? Number(my[1]) : null, folders };
  });
  return { status: 'ok', ...data };
}

// List the individual documents in Storage (the datascroller cards). The list
// lazy-loads, so pass scroll_all=true to wheel-scroll until every card is in
// the DOM. Each card only exposes "Scanned Letter" + a date (+ a "Stored in
// <folder>" tag once filed), so that is all we can report per document.
// Wheel-scroll the Storage datascroller until it stops adding cards, so every
// document is in the DOM. Anything addressing a document BY INDEX must do this
// first: the indices reported by listStorageDocuments(scrollAll) cover all 98
// documents, while a freshly opened Storage view only has the first batch —
// addressing index 80 against that view fails as "out of range".
async function loadAllCards(p) {
  const cards = p.locator('div.letter-wrapper');
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const before = await cards.count();
    await p.mouse.wheel(0, 6000);
    await p.waitForTimeout(1000);
    stable = (await cards.count()) === before ? stable + 1 : 0;
  }
  return cards.count();
}

async function listStorageDocuments(p, { scrollAll = false } = {}) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2000);
  if (scrollAll) await loadAllCards(p);
  const docs = await p.$$eval('div.letter-wrapper', els => els.map((el, i) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const dates = [...el.innerText.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map(m => m[0]);
    const stored = (el.innerText.match(/Stored in\s+([^\n]+)/) || [])[1];
    return { index: i, date: dates[0] || null, storedIn: stored ? clean(stored) : null, preview: clean(el.innerText).slice(0, 100) };
  }));
  return { status: 'ok', count: docs.length, documents: docs };
}

async function createFolder(p, name) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  const cf = p.getByText('Create a folder', { exact: false }).first();
  if (!(await cf.count())) throw new Error('"Create a folder" button not found');
  await cf.click({ timeout: 10000 });
  await p.waitForTimeout(1500);
  // The add-folder dialog owns its fields by id: name input ends ":folder-name",
  // the confirm button ends ":create-btn". A generic button lookup instead hits
  // the background "Create a folder" button behind the modal mask, so target the
  // dialog controls directly.
  const input = p.locator('[id$=":folder-name"]').first();
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.fill(name, { timeout: 8000 });
  await p.waitForTimeout(400);
  const createBtn = p.locator('[id$=":create-btn"]').first();
  if (await createBtn.count()) await createBtn.click({ timeout: 8000, force: true });
  else await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  // Clicking is not creating. A duplicate name, or one the portal will not
  // accept, leaves the dialog open with its complaint in it — and this reported
  // a folder that does not exist, which the next store call then cannot find.
  if (await input.isVisible().catch(() => false)) {
    const why = await p.locator('[id*="folder"]').filter({ hasText: /already|exists|invalid|ung.ltig|vorhanden/i })
      .first().innerText().catch(() => '');
    return {
      status: 'refused',
      name,
      reason: why.replace(/\s+/g, ' ').trim().slice(0, 200) || 'the portal kept the dialog open',
    };
  }
  return { status: 'ok', created: name };
}

// Move a Storage document into one of the user's custom folders. Flow verified
// live against the real DOM: open the card's action menu ("..."), click the
// (visible) "Move" item, then in the "Select a folder" bottom sheet tick the
// target folder's checkbox and press the sheet's "Move" button.
//
// The document is addressed by its position (index) in the currently loaded
// My-Documents datascroller, or by a text substring (e.g. a date "30.05.2025").
// Pick the lowest on-screen match for both the folder option and the Move
// button, since the bottom sheet renders below the (dimmed) folder tiles.
async function moveToFolder(p, { index, title, folder, add = true, remove = null }) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2000);
  // Indices come from listStorageDocuments(scroll_all), which sees every card;
  // a freshly opened Storage view only holds the first lazy-loaded batch, so
  // load the rest before resolving one by position.
  await loadAllCards(p);

  // Resolve the target document card (Storage documents are div.letter-wrapper).
  const cards = p.locator('div.letter-wrapper');
  let card;
  if (typeof index === 'number') {
    checkIndex(index, await cards.count(), 'loaded documents');
    card = cards.nth(index);
  } else if (title) {
    card = await cardByTitle(p, title);
  } else {
    throw new Error('pass either index or title');
  }
  await card.scrollIntoViewIfNeeded().catch(() => {});

  // Open this card's action menu ("...").
  const menuBtn = card.locator('.letter-action-menu').first();
  if (!(await menuBtn.count())) throw new Error('action menu ("...") not found on the document');
  await menuBtn.click({ timeout: 8000 });
  await p.waitForTimeout(1000);

  // Click the visible "Move" item (there is one hidden tooltip menu per card).
  if (!(await clickVisibleByText(p, 'Move'))) throw new Error('"Move" menu item did not become visible');
  await p.waitForTimeout(1800);

  // "Select a folder" bottom sheet. Each folder option is a `.brand-container`
  // holding the name and a PrimeFaces checkbox. The checkbox sits low in a
  // horizontal strip where a real Playwright click can be swallowed, so select
  // it by dispatching a click in-page on the VISIBLE container's checkbox.
  await p.locator('[id*="storage-folder-selection"]').filter({ hasText: 'Select a folder' }).first()
    .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  // ePost folder membership is a multi-select of checkboxes (a document can live
  // in several folders), so "adding to a folder" means TICKING its box. Toggling
  // is dangerous for bulk filing — ticking an already-member folder would REMOVE
  // it — so this is idempotent: only tick when not already a member, and no-op
  // (close the sheet unchanged) when the document is already filed there.
  const picked = await p.evaluate(({ folderName, add, removeName }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    // Scoped to the open sheet: .brand-container is also used for decorative
    // blocks and for the cards behind it, so a document-wide lookup can tick a
    // box that is not in the sheet at all. And compared NFC-folded, because the
    // portal serves folder names decomposed while a caller types them composed
    // — the trap this whole file exists to work around, and the one place that
    // still compared byte-exactly.
    const sheet = document.querySelector('[id*="storage-folder-selection"]') || document;
    const nfc = t => (t || '').normalize('NFC');
    const boxFor = name => [...sheet.querySelectorAll('.brand-container')]
      .find(c => nfc(clean(c.innerText)) === nfc(name) && c.offsetParent !== null);
    // The box is a toggle, so clicking is only correct when the current state
    // differs from the state we want. Ticking an existing membership would
    // silently REMOVE it, and vice versa.
    const toggle = (bc, want) => {
      const box = bc.querySelector('.ui-chkbox-box');
      const on = box ? box.classList.contains('ui-state-active') : false;
      const tgt = box || bc.querySelector('.folder-wrapper') || bc;
      tgt.scrollIntoView({ block: 'center', inline: 'center' });
      const click = want ? !on : on;
      if (click) tgt.click();
      return { on, click };
    };
    const bc = boxFor(folderName);
    if (!bc) return { ok: false };
    const main = toggle(bc, add);
    // Re-filing: drop the old membership in the SAME sheet. Doing it alone
    // would leave an empty folder set, which the portal refuses to commit.
    let removed = null;
    let removeMissing = false;
    if (removeName && removeName !== folderName) {
      const rc = boxFor(removeName);
      // A folder the sheet does not offer used to be skipped in silence: the
      // destination was ticked, the sheet committed, and the tool reported a
      // move that had only ever added.
      if (!rc) removeMissing = true;
      else removed = toggle(rc, false).click;
    }
    return { ok: true, already: main.on, changed: main.click || !!removed, removed, removeMissing };
  }, { folderName: folder, add, removeName: remove });
  if (!picked.ok) throw new Error(`folder "${folder}" not offered in the move sheet`);
  if (picked.removeMissing) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    throw new Error(`remove_from "${remove}" is not offered in the move sheet — nothing was changed`);
  }
  await p.waitForTimeout(600);

  if (!picked.changed) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    return { status: 'ok', folder, unchanged: true, in_folder: picked.already };
  }

  // Confirm with the sheet's Move button (own id ":moveBtn"; aria-disabled can
  // lag behind the real state once a folder is ticked, so force the click).
  const confirmBtn = p.locator('[id$=":moveBtn"]').first();
  if (!(await confirmBtn.count())) throw new Error('move confirm button (:moveBtn) not found');
  await confirmBtn.click({ timeout: 8000, force: true });
  await p.waitForTimeout(1500);

  // Some moves raise a confirmation popup — accept it best-effort if present.
  const popup = p.locator('[id*="folderMovingConfirmationPopup"]');
  if (await popup.count()) {
    for (const label of ['Yes', 'Move', 'Confirm', 'OK']) {
      const b = popup.getByText(label, { exact: true }).first();
      if ((await b.count()) && await b.isVisible().catch(() => false)) { await b.click({ timeout: 5000 }).catch(() => {}); break; }
    }
  }
  await p.waitForTimeout(2500);

  // The portal refuses to commit an empty folder set, and it says so by simply
  // leaving the sheet open. Returning "moved" on that would tell the caller a
  // document had left a folder it is in fact still in — a wrong answer is worse
  // here than an error, because nothing downstream can tell the two apart.
  const sheet = p.locator('[id*="storage-folder-selection"]').first();
  if (await sheet.isVisible().catch(() => false)) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    return {
      status: 'refused',
      folder,
      reason: 'the portal did not accept the folder sheet',
      hint: add
        ? 'the sheet stayed open — the folder may no longer be offered for this document'
        : 'a document cannot be left in no folder at all; use epost_move_to_folder with a destination instead',
    };
  }
  return { status: 'ok', moved: { index, title, folder } };
}

// Where the browser is, with nothing that could be replayed: OIDC steps carry a
// code, a state and a session id in the query string.
function safeUrl(u) {
  try { const x = new URL(u); return `${x.origin}${x.pathname}${x.search ? '?…' : ''}`; }
  catch { return '(unparsable url)'; }
}

// The SwissID account e-mail, used to skip the "which account?" step.
function swissIdUser() {
  return envOrKeychain('EPOST_SWISSID_USER', 'epost-mcp-swissid-user');
}

// Assisted login: drive every step of the SwissID chain that does NOT need a
// human, and stop at the one that does — the biometric prompt.
//
//   app.epost.ch → login.epost.ch    click "Login mit SwissID"
//                → login-email        fill the account e-mail, "Weiter"
//                → confirm-passkey    "Weiter"  → macOS asks for Touch ID
//                → (login-password)   fallback: "Mit Passkey anmelden"
//                → app.epost.ch, authenticated
//
// This is the practical answer to unattended login being impossible: a passkey
// cannot be used without genuine user presence, but everything around it can be
// automated, so an expired session costs one fingerprint instead of an e-mail,
// a password and an SMS code. Needs a signed browser — see findChromium.
async function assistedLogin(p, waitMs = 300000) {
  const user = swissIdUser();
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.bringToFront().catch(() => {});

  const deadline = Date.now() + waitMs;
  const done = new Set();
  let lastSeen = '';
  // Marked done only once it worked. Marking first meant a control that had
  // not finished rendering was tried exactly once, failed, and never tried
  // again — a login that would have succeeded a second later instead sat there
  // until the window ran out.
  const once = async (step, action) => {
    if (done.has(step)) return false;
    if (DEBUG) console.error('[login]', step);
    try {
      await action();
    } catch (e) {
      if (DEBUG) console.error('[login]', step, 'not yet:', (e.message || '').split('\n')[0].slice(0, 80));
      return false;
    }
    done.add(step);
    return true;
  };

  while (Date.now() < deadline) {
    await p.waitForTimeout(1500);
    const u = p.url();
    // Origin and path only. A SwissID/OIDC step carries the authorisation code,
    // the state and the session id in its query string, and truncating at 90
    // characters is not redaction — it is a coin toss about which of them ends
    // up in the log the user pastes into a bug report.
    if (DEBUG && u !== lastSeen) { console.error('[login] at', safeUrl(u)); lastSeen = u; }

    if (/app\.epost\.ch/.test(u) && !/oauth_login|openid-connect/.test(u)
      && (u.includes('DigitalLetterboxOverview')
        || await p.locator('div.letter-wrapper').count().catch(() => 0)
        || await p.getByText('Digital Letterbox', { exact: false }).count().catch(() => 0))) {
      return ensureLetterbox(p);
    }
    if (/login\.epost\.ch/.test(u) && await once('swissid', async () => {
      const b = p.getByRole('button', { name: /Login mit SwissID/i }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 8000 }).catch(() => {});
    })) continue;

    if (/login-email/.test(u) && user && await once('email', async () => {
      const i = p.locator('input[type=text], input[type=email]').first();
      if (await i.count().catch(() => 0)) {
        await i.fill(user, { timeout: 8000 }).catch(() => {});
        const n = p.getByRole('button', { name: /^Weiter$|^Continue$/i }).first();
        if (await n.count().catch(() => 0)) await n.click({ timeout: 8000 }).catch(() => {});
      }
    })) continue;

    // Clicking Weiter here raises the Touch ID sheet — the one step only the
    // human can finish.
    if (/confirm-passkey/.test(u) && await once('confirm', async () => {
      const n = p.getByRole('button', { name: /^Weiter$|^Continue$/i }).first();
      if (await n.count().catch(() => 0)) await n.click({ timeout: 8000 }).catch(() => {});
    })) continue;

    if (/login-password/.test(u) && await once('offer-passkey', async () => {
      const b = p.getByRole('button', { name: /Mit Passkey anmelden|passkey/i }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 8000 }).catch(() => {});
    })) continue;
  }
  return 'login_required';
}

// Letterbox access. An expired session cannot be healed without a human — see
// the note on passkeys above — so this reports login_required and the caller
// runs epost_login, which drives everything except the fingerprint.
function ensureSession(p) {
  return ensureLetterbox(p);
}


// Move a letter out of the inbox into Storage ("Store" in the card menu). This
// is the archive action: unlike Delete it keeps the document, it just stops
// cluttering the inbox. Letters are addressed the same way as elsewhere — by
// list index, or by a text substring such as a date.
async function storeLetter(p, { index, title, folder }) {
  const st = await ensureSession(p);
  if (st !== 'ok') return { status: st };
  // Storing re-renders the list, and a menu or overlay left over from the
  // previous call silently swallows the next click ("locator.click: Timeout").
  // Start every store from a freshly rendered overview instead.
  await p.keyboard.press('Escape').catch(() => {});
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const cards = p.locator('div.letter-wrapper');
  await cards.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  let card;
  if (typeof index === 'number') {
    checkIndex(index, await cards.count(), 'letters');
    card = cards.nth(index);
  } else if (title) {
    card = await cardByTitle(p, title);
  } else throw new Error('pass either index or title');

  const label = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 80);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  const menu = card.locator('.letter-action-menu').first();
  if (!(await menu.count())) throw new Error('action menu ("...") not found on the letter');
  await menu.click({ timeout: 8000 });
  await p.waitForTimeout(1000);
  if (!(await clickVisibleByText(p, 'Store'))) throw new Error('"Store" menu item did not become visible');
  await p.waitForTimeout(2200);

  // Store is TWO steps. The menu item only opens a "Select a folder" sheet with
  // one checkbox per folder and its own Store button, greyed out until a folder
  // is ticked. Clicking the menu item and stopping leaves that sheet open: the
  // call looks successful, nothing is archived, and the open overlay swallows
  // every later click.
  // Scope the tile lookup to the SHEET. `.brand-container` also matches letter
  // cards in the list behind it, so a document-wide scan reads the inbox instead
  // of the folder tiles — and reports the letter's own text as an offered
  // "folder". Wait until the sheet actually holds tiles before reading.
  const sheet = p.locator('[id*="storage-folder-selection"]').first();
  await sheet.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await sheet.locator('.brand-container').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const picked = await sheet.evaluate((root, folderName) => {
    // Normalise: macOS and the portal disagree on whether "ä" is one code point
    // or "a" plus a combining diaeresis, and a byte-exact compare then fails on
    // a folder name that looks identical on screen.
    const clean = s => (s || '').replace(/\s+/g, ' ').trim().normalize('NFC');
    // The tiles sit in a horizontally scrolling strip, so the ones off to the
    // right are not "visible" — filtering on offsetParent silently hides half
    // the folders and the target looks unavailable. Take them all and scroll
    // the wanted one into view before clicking.
    const tiles = [...root.querySelectorAll('.brand-container')];
    const offered = tiles.map(c => clean(c.innerText));
    const want = folderName.normalize('NFC');
    const bc = tiles.find(c => clean(c.innerText) === want)
      || tiles.find(c => clean(c.innerText).toLowerCase() === want.toLowerCase());
    if (!bc) return { ok: false, offered };
    bc.scrollIntoView({ block: 'center', inline: 'center' });
    const box = bc.querySelector('.ui-chkbox-box');
    // Checkboxes are toggles: only click when the state differs from what we want.
    if (!(box && box.classList.contains('ui-state-active'))) (box || bc).click();
    return { ok: true, offered };
  }, folder);
  if (!picked.ok) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    throw new Error(`folder "${folder}" not in the store sheet. Offered: ${picked.offered.join(' | ')}`);
  }
  await p.waitForTimeout(700);

  // Confirm with the sheet's own Store button. aria-disabled lags behind the
  // real state once a folder is ticked, so force the click.
  const confirm = sheet.getByText('Store', { exact: true }).last();
  if (await confirm.count().catch(() => 0)) {
    await confirm.click({ timeout: 8000, force: true }).catch(() => {});
  } else if (!(await clickVisibleByText(p, 'Store'))) {
    throw new Error('store confirm button not found in the sheet');
  }
  await p.waitForTimeout(3000);
  return { status: 'ok', stored: label, folder };
}


// Open a Storage document and read what the portal knows about it — optionally
// saving the PDF. This is the piece that makes sorting the archive possible: the
// card list only ever says "Gescannter Brief", while the detail panel names the
// actual sender, the document type and the amount.
//
// Storage documents ARE downloadable, contrary to what the card's "..." menu
// suggests: the menu only offers Copy / Move / Delete, but clicking the card
// opens a viewer whose toolbar carries the same "Download File" button as the
// inbox. Looking only at the menu is what made this look impossible.
async function readStorageDocument(p, { index, title, outputDir }) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(1500);
  await loadAllCards(p);

  const cards = p.locator('div.letter-wrapper');
  let card;
  if (typeof index === 'number') {
    checkIndex(index, await cards.count(), 'documents');
    card = cards.nth(index);
  } else if (title) {
    card = await cardByTitle(p, title);
  } else throw new Error('pass either index or title');

  await card.scrollIntoViewIfNeeded().catch(() => {});
  // The click target is the card body; the outer wrapper does not carry it.
  const body = card.locator('.letter-content').first();
  await (await body.count() ? body : card).click({ timeout: 10000 });
  await p.waitForTimeout(3500);

  const meta = await p.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const body = clean(document.body.innerText);
    const pick = re => (re.exec(body) || [])[1]?.trim() || null;
    return {
      // Every card behind the detail also says "Gescannter Brief", so an
      // unconstrained match starts at the first one and swallows the whole list
      // down to the first amount. The subject may therefore not cross another
      // occurrence, which pins the match to the detail's own heading.
      // An earlier version excluded the letter C instead, to stop before "CHF".
      // That worked by accident and returned null for every sender whose name
      // begins with one — Coop, CSS, Concordia — and for anything not an invoice.
      subject: pick(/Gescannter Brief\s+((?:(?!Gescannter Brief).)+?)(?=\s+CHF\b|\s+Document type|$)/i),
      documentType: pick(/Document type\s+(\S+)/i),
      documentDate: pick(/Document date\s+(\d{2}\.\d{2}\.\d{4})/i),
      amount: pick(/CHF\s+([\d'’,.]+)/),
      // Read the folder from its own element: in the flattened innerText the
      // name runs into whatever follows it, which is account-specific. It must
      // be a VISIBLE one, though — every card behind the open detail carries
      // the same class, and taking the first in the document reported the
      // folder of whichever document happened to come first on the page.
      storedIn: (() => {
        // Anchor on something only the detail has. "Document type" appears in
        // the open panel and nowhere on a card; the cards behind it all carry
        // .storage-location-info, and visibility does not separate them
        // because the panel covers them rather than hiding them. So: the
        // smallest element that contains both, and its folder.
        const scope = [...document.querySelectorAll('div, section, article, main')]
          .filter(n => n.querySelector('.storage-location-info') && /Document type/i.test(n.innerText || ''))
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
        const el = (scope || document).querySelector('.storage-location-info');
        if (el) return clean(el.innerText).replace(/^Stored in\s*/i, '') || null;
        return pick(/Stored in\s+(.+?)(?=\s+Tracking number|\s+Letter ID|\s+Document type|$)/i);
      })(),
      trackingNumber: pick(/Tracking number:\s*(\S+)/i),
      letterId: pick(/Letter ID:\s*(\S+)/i),
    };
  });

  let saved = null;
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    const btn = p.getByRole('button', { name: 'Download File' }).first();
    const target = (await btn.count()) ? btn : p.locator('a.st-harddrive-download').first();
    if (await target.count()) {
      const [d] = await Promise.all([
        p.waitForEvent('download', { timeout: 25000 }),
        target.click({ timeout: 10000 }),
      ]);
      const stamp = (meta.documentDate || '').split('.').reverse().join('-') || 'undated';
      saved = join(outputDir, `${namePart(stamp)}_ePostStorage_${namePart(index ?? 'x')}.pdf`);
      await d.saveAs(saved);
      try { chmodSync(saved, 0o600); } catch { /* the download may live elsewhere */ }
    }
  }
  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(1200);
  // A caller that asked for the file and got `saved: null` beside `status: ok`
  // was told the whole request succeeded. It did not: the reading half did.
  if (outputDir && !saved) {
    return { status: 'partial', index, ...meta, saved: null, error: 'no download control on the document view — the metadata below was read, the file was not saved' };
  }
  return { status: 'ok', index, ...meta, saved };
}

// Click the first VISIBLE element whose exact text is `t`.
async function clickVisibleByText(p, t) {
  const loc = p.getByText(t, { exact: true });
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 6000 }); return true; }
  }
  return false;
}

// --- MCP wiring -------------------------------------------------------------

const TOOLS = [
  { name: 'epost_status', description: 'Check whether the ePost session is alive (ok) or an interactive SwissID login is needed (login_required).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_login', description: 'Open a VISIBLE browser window and drive the whole SwissID login except the biometric prompt: it goes to SwissID, fills the account e-mail and requests the passkey, so you only confirm with Touch ID. Falls back to a normal manual login. Caches the session afterwards.', inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 30, description: 'how long to keep the window open (default 300, minimum 30 — a SwissID redirect chain takes longer than that on its own)' } } } },
  { name: 'epost_settings', description: 'Show the resolved configuration: which browser is driven and why, whether it can use Touch ID passkeys, the profile/state paths, and whether the SwissID account e-mail is configured.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_letters', description: 'List the letters currently in the digital letterbox (index, id, sender, title, date, read). Over the API at most `limit` are returned and the reply says so when that window was filled.', inputSchema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, description: 'how many to fetch over the API (default 200)' } } } },
  { name: 'epost_download_letter', description: 'Download one letter to output_dir, addressed by list index or by letter_id. Returns the saved path (YYYY-MM-DD_ePost_<index>.pdf), written 0600.', inputSchema: { type: 'object', properties: { index: { type: 'number', minimum: 0 }, letter_id: { type: 'string', description: 'instead of index; needs the public API' }, output_dir: { type: 'string' } }, required: ['output_dir'] } },
  { name: 'epost_download_all', description: 'Download every letter in the letterbox to output_dir. Returns the saved paths.', inputSchema: { type: 'object', properties: { output_dir: { type: 'string' } }, required: ['output_dir'] } },
  { name: 'epost_store_letter', description: 'Archive a letter into a Storage folder (the "Store" action): keeps the document, this is not a delete. A target folder is REQUIRED — Store opens a "Select a folder" sheet and will not commit without one. Address the letter by index in the inbox list, or by a text substring such as a date; indices shift after each store, so re-list between calls.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, letter_id: { type: 'string', description: 'API letter id (preferred — indices shift)' }, folder: { type: 'string', description: 'existing Storage folder to file it into' } }, required: ['folder'] } },
  { name: 'epost_search', description: 'Full-text search across your letters — keywords are matched inside the letter content, not just the metadata. Optionally limit to the inbox or to Storage. API only; there is no equivalent in the portal automation.', inputSchema: { type: 'object', properties: { keyword: { type: 'string' }, location: { type: 'string', enum: ['ALL', 'INBOX', 'STORAGE'], description: 'default ALL' }, limit: { type: 'number' } }, required: ['keyword'] } },
  { name: 'epost_get_letter', description: 'Get one letter by its id, with the sender description, document types, dates and read status.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'epost_unread_count', description: 'How many unread letters are in the inbox.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_set_read_status', description: 'Mark letters READ or UNREAD by id.', inputSchema: { type: 'object', properties: { letter_ids: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['READ', 'UNREAD'] } }, required: ['letter_ids', 'status'] } },
  { name: 'epost_list_deleted', description: 'Letters in the trash, with the days remaining before they are permanently removed.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_restore_letter', description: 'Restore a deleted letter back to the inbox.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' } }, required: ['letter_id'] } },
  { name: 'epost_delete_letter', description: 'DESTRUCTIVE: move a letter to the trash. Requires confirm:true. Prefer epost_store_letter to archive something — deleting is not how you tidy an inbox.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['letter_id', 'confirm'] } },
  { name: 'epost_download_thumbnail', description: 'Save the thumbnail image of a letter — useful to eyeball a document without fetching the whole PDF.', inputSchema: { type: 'object', properties: { letter_id: { type: 'string' }, output_path: { type: 'string' } }, required: ['letter_id', 'output_path'] } },
  { name: 'epost_list_storage', description: 'List the user\'s custom folders (name + document count) in the ePost Storage area plus the unsorted My-Documents count.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_storage_documents', description: 'List the documents in Storage. Over the API each carries a real description ("Invoice from ...") and documentTypes; over the browser fallback only a date and the folder tag. Pass folder_id to list one folder, scroll_all for the browser path.', inputSchema: { type: 'object', properties: { folder_id: { type: 'string', description: 'limit to one folder (API only)' }, limit: { type: 'number' }, scroll_all: { type: 'boolean', description: 'browser fallback: load every card first' } } } },
  { name: 'epost_read_storage_document', description: 'Open one Storage document and report what the portal knows about it: the real sender/subject line, document type, date, amount and current folder. The card list only ever shows "Gescannter Brief", so this is the only way to classify an archived document. Pass output_dir to also save the PDF.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, letter_id: { type: 'string' }, folder_id: { type: 'string' }, output_dir: { type: 'string', description: 'save the PDF here as well' } } } },
  { name: 'epost_create_folder', description: 'Create a new custom folder in the ePost Storage area.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'epost_unfile_from_folder', description: 'Remove a Storage document from a folder. NOTE: the portal will not commit an empty folder set, so this only works when the document is in more than one folder; to empty a folder that holds the document\'s only membership, use epost_move_to_folder with remove_from instead.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, folder: { type: 'string' } }, required: ['folder'] } },
  { name: 'epost_move_to_folder', description: 'File a Storage document into a custom folder (addressed by index in the loaded My-Documents list, or by a text substring such as a date). Pass remove_from to re-file: the old folder is unticked in the same sheet, which is the only way to empty a folder that holds the document\'s only membership. ePost documents can belong to several folders, so this ADDS the folder membership: it is idempotent (no-op if already filed there) and removes nothing unless remove_from says which. Note: filing a document bumps it to the top of the "Last used" order, so re-list before addressing the next one by index.', inputSchema: { type: 'object', properties: { index: { type: 'number', minimum: 0 }, title: { type: 'string' }, folder: { type: 'string' }, remove_from: { type: 'string', description: 'folder to drop in the same step (re-file)' } }, required: ['folder'] } },
];

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

// One browser-backed tool call at a time. Every one of them drives the same
// page: two running together interleave, so one call's goto lands while the
// other is mid-click and both are handed an answer that belongs to neither
// request. A client is free to pipeline requests, so this is not exotic.
let browserQueue = Promise.resolve();
function acquireBrowser() {
  let release;
  const held = new Promise(r => { release = r; });
  const ourTurn = browserQueue;
  browserQueue = browserQueue.then(() => held);
  return ourTurn.then(() => release);
}

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });

  // The page the browser-backed tools work on, resolved on first use — and only
  // then does this call take its turn at the browser. A tool the API serves in
  // full never waits for one that does not, and never launches anything.
  let pending = null;
  let releaseBrowser = null;
  const p = async () => {
    // `browser` was enforced; `api` was not, so pinning to the API still fell
    // through to the portal, quietly doing something other than what was asked,
    // on a machine that may have no browser at all. A pin now means what it says
    // in both directions.
    if (TRANSPORT === 'api') {
      throw new Error(`${name} needs the browser, and EPOST_TRANSPORT=api pins this server to the public API — unset it or set it to "auto" to allow the fallback`);
    }
    releaseBrowser ??= await acquireBrowser();
    return (pending ??= getPage());
  };

  try {
    if (name === 'epost_status') {
      const status = await ensureSession(await p());
      await saveState();
      return text({ status });
    }
    if (name === 'epost_login') {
      const p = await getPage(true);
      // Clamped, and the schema says so now: a five-second window cannot
      // outlast the redirect chain, so honouring it would only ever report a
      // timeout that the caller caused.
      const status = await assistedLogin(p, Math.max(30, Number(args.wait_seconds) || 300) * 1000);
      await saveState();
      const passkeyCapable = browserChoice.key && browserChoice.key !== 'chromium';
      return text({
        status,
        browser: browserChoice.key,
        message: status === 'ok'
          ? `Login OK — session cached to ${STATE}`
          : (passkeyCapable
            ? 'Not completed in time. The window drives everything except the biometric prompt — confirm that with Touch ID.'
            : 'Not completed in time. NOTE: the bundled Chromium cannot use Touch ID; set EPOST_BROWSER=chrome for a one-touch login.'),
      });
    }
    if (name === 'epost_settings') {
      // Deliberately side-effect free: reporting configuration must not start a
      // browser. It used to probe the platform authenticator by opening a page,
      // which made a read-only question cost a browser launch — and hung
      // wherever a browser is unavailable.
      const user = swissIdUser();
      const signed = browserChoice.key && browserChoice.key !== 'chromium';
      return text({
        transport: TRANSPORT,
        api: apiUnavailable ? `unavailable: ${redact(apiUnavailable)}`
          : [apiCredentials() && 'password grant', apiKey() && 'X-API-KEY'].filter(Boolean).join(' + ')
            || 'no credentials configured',
        browser: {
          key: browserChoice.key || '(none launched yet)',
          path: browserChoice.path,
          chosen_because: browserChoice.reason || 'not resolved yet',
        },
        touch_id_passkeys: browserChoice.key
          ? (signed ? 'expected to work (signed system browser)'
            : 'NOT available — the bundled Chromium cannot reach the platform authenticator; set EPOST_BROWSER=chrome')
          : 'unknown until a browser is launched',
        // Masked whatever shape it has. The pattern only matched an e-mail, so a
        // value that was not one — a misconfiguration, or a secret pasted into
        // the wrong variable — came back verbatim.
        swissid_user: user
          ? (/^.+@.+$/.test(user) ? user.replace(/^(.).*(@.*)$/, '$1***$2') : `${user[0]}*** (${user.length} chars, not an e-mail)`)
          : 'not set — epost_login cannot skip the e-mail step',
        paths: { state: STATE, profile: PROFILE },
        settings: {
          EPOST_TRANSPORT: 'auto | api | browser',
          EPOST_BROWSER: 'chrome | chrome-canary | edge | brave | chromium | /absolute/path',
          EPOST_API_PASSWORD: 'API password (or keychain item "epost-mcp-api-password")',
          EPOST_API_KEY: 'X-API-KEY (or keychain item "epost-mcp-api-key")',
          EPOST_SWISSID_USER: 'account e-mail (or keychain item "epost-mcp-swissid-user")',
          EPOST_APP_URL: 'portal base, for tests',
          EPOST_STATE: 'cached session file',
          EPOST_PROFILE: 'persistent browser profile',
          EPOST_DEBUG: '1 to trace the login steps on stderr',
        },
      });
    }

    if (name === 'epost_list_letters') {
      const limit = args.limit || 200;
      const viaApi = await apiListLetters(limit);
      if (viaApi) {
        // A full page is indistinguishable from a complete inbox, and a caller
        // that looked up a letter by id in this list would be told it does not
        // exist. Say so rather than presenting a window as the whole thing.
        const truncated = viaApi.length >= limit;
        return text({
          transport: 'api', count: viaApi.length, letters: viaApi.map(apiLetterRow),
          ...(truncated ? { truncated: true, hint: `exactly ${limit} came back, so there may be more — raise limit` } : {}),
        });
      }
      const st = await ensureSession(await p());
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const out = await listLetters(await p());
      await saveState();
      // The same envelope as the API path. Returning a bare array here meant a
      // client read `.letters` while the API was up and got undefined the moment
      // it was not — a shape that changed under them for reasons of their own.
      return text({ transport: 'browser', count: out.length, letters: out });
    }
    if (name === 'epost_download_letter' || name === 'epost_download_all' || name === 'epost_read_storage_document') {
      // mkdirSync takes no descriptors, but it does accept a number and then
      // fails somewhere less legible than here.
      if (args.output_dir !== undefined && (typeof args.output_dir !== 'string' || !args.output_dir.trim())) {
        throw new Error(`output_dir must be a path, not ${typeof args.output_dir}`);
      }
    }
    if (name === 'epost_download_letter') {
      // letter_id is an API concept. The browser path addresses by position, so
      // falling through with an id set silently answered a different question —
      // and with index also supplied it answered it using that instead.
      if (args.letter_id && typeof args.index === 'number') {
        return text({ error: 'pass either letter_id or index, not both — they address different things' });
      }
      const apiLetters = await apiListLetters(200);
      if (!apiLetters && args.letter_id) {
        return text({ error: 'letter_id needs the public API and it is unavailable', hint: redact(apiUnavailable || 'configure an API password or key'), note: 'address the letter by index to use the portal instead' });
      }
      if (apiLetters) {
        const l = args.letter_id ? apiLetters.find(x => x.id === args.letter_id) : apiLetters[args.index];
        if (l) {
          const bytes = await apiLetterContent(l.id);
          if (bytes) {
            mkdirSync(args.output_dir, { recursive: true });
            const stamp = (l.receivedDateTime || '').slice(0, 10) || 'undated';
            const saved = join(args.output_dir, `${namePart(stamp)}_ePost_${namePart(args.index ?? l.id)}.pdf`);
            // Correspondence: written with the process umask it can land
            // group- and world-readable.
            writePrivate(saved, bytes);
            return text({ transport: 'api', saved, bytes: bytes.length, description: l.description });
          }
        }
      }
      const st = await ensureSession(await p());
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const letters = await listLetters(await p());
      const saved = await downloadLetter(await p(), args.index, args.output_dir, letters[args.index]);
      await saveState();
      return text({ saved });
    }
    if (name === 'epost_download_all') {
      const st = await ensureSession(await p());
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const letters = await listLetters(await p());
      const saved = [];
      for (const l of letters) saved.push(await downloadLetter(await p(), l.index, args.output_dir, l));
      await saveState();
      return text({ count: saved.length, saved });
    }
    if (name === 'epost_store_letter') {
      if (!args.folder) throw new Error('folder is required — the Store sheet will not commit without one');
      // The API archives in one PATCH; the browser needs the two-step folder
      // sheet. Resolve the folder name to its id, and address the letter by id.
      const dirs = await apiListDirectories();
      if (dirs) {
        const want = String(args.folder).normalize('NFC').toLowerCase();
        const dir = dirs.find(d => d.directoryId && (d.directoryName || '').normalize('NFC').toLowerCase() === want);
        if (!dir) {
          return text({ error: `folder "${args.folder}" not found`, available: dirs.filter(d => d.directoryId).map(d => d.directoryName) });
        }
        const letters = await apiListLetters(200);
        if (!letters && args.letter_id) {
          return text({ error: 'letter_id needs the public API and it is unavailable', hint: redact(apiUnavailable || 'configure an API password or key'), note: 'address the letter by index or title to use the portal instead' });
        }
        if (letters) {
          const l = args.letter_id ? letters.find(x => x.id === args.letter_id)
            : typeof args.index === 'number' ? letters[args.index]
              : args.title ? oneByTitle(letters, args.title) : null;
          if (!l && args.letter_id) {
            // Falling through to the browser here would complain about a
            // missing index, which sends the reader looking in the wrong place.
            return text({
              error: `no letter ${args.letter_id} in the inbox`,
              hint: 'it may already be archived — epost_list_storage_documents shows what is in Storage',
            });
          }
          if (l && await apiArchiveLetter(l.id, dir.directoryId)) {
            await saveState();
            return text({ transport: 'api', stored: l.description || l.letterTitle, folder: dir.directoryName, id: l.id });
          }
        }
      }
      // Only a session problem is a session problem: flattening every non-ok
      // status into "log in again" sent the caller to the wrong remedy the moment
      // a tool grew a second failure mode, such as a sheet the portal refused.
      const out = await storeLetter(await p(), { index: args.index, title: args.title, folder: args.folder });
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_search') {
      const res = await apiSearch(args.keyword, args.location || 'ALL', args.limit || 50);
      if (!res) return text({ error: 'search needs the API', hint: apiUnavailable || 'configure an API password or key' });
      const items = Array.isArray(res) ? res : (res.letters || res.content || []);
      // A full page of matches is not "these are all the matches", and the
      // difference decides whether a caller concludes a letter does not exist.
      const searchLimit = args.limit || 50;
      return text({
        transport: 'api', count: items.length, letters: items.map(apiLetterRow),
        ...(items.length >= searchLimit ? { truncated: true, hint: `exactly ${searchLimit} matched, so there may be more — raise limit` } : {}),
      });
    }
    if (name === 'epost_get_letter') {
      const l = await apiGetLetter(args.letter_id);
      if (!l) return text({ error: 'not found, or the API is unavailable', hint: apiUnavailable });
      return text({ transport: 'api', ...apiLetterRow(l, 0), raw: l });
    }
    if (name === 'epost_unread_count') {
      const c = await apiUnreadCount();
      if (c === null) return text({ error: 'needs the API', hint: apiUnavailable });
      return text({ transport: 'api', unread: typeof c === 'object' ? (c.count ?? c.unreadCount ?? c) : c });
    }
    if (name === 'epost_set_read_status') {
      const ok = await apiSetRead(args.letter_ids, args.status);
      return text(ok ? { transport: 'api', updated: args.letter_ids.length, status: args.status }
        : { error: 'needs the API', hint: apiUnavailable });
    }
    if (name === 'epost_list_deleted') {
      const res = await apiDeletedLetters();
      if (!res) return text({ error: 'needs the API', hint: apiUnavailable });
      const items = Array.isArray(res) ? res : (res.letters || res.content || []);
      return text({ transport: 'api', count: items.length, letters: items });
    }
    if (name === 'epost_restore_letter') {
      const ok = await apiRestoreLetter(args.letter_id);
      return text(ok ? { transport: 'api', restored: args.letter_id } : { error: 'needs the API', hint: apiUnavailable });
    }
    if (name === 'epost_delete_letter') {
      // Deleting is the one irreversible-ish action here, and it is never the
      // right way to tidy an inbox — archiving is. Hence the explicit gate.
      if (args.confirm !== true) {
        return text({ refused: 'confirm:true is required', note: 'to file a letter away use epost_store_letter; delete only when you mean to discard it' });
      }
      const ok = await apiDeleteLetter(args.letter_id);
      return text(ok ? { transport: 'api', deleted: args.letter_id, note: 'recoverable with epost_restore_letter until it expires from the trash' }
        : { error: 'needs the API', hint: apiUnavailable });
    }
    if (name === 'epost_download_thumbnail') {
      // Checked before anything else touches it: dirname() on a number throws
      // a TypeError about paths, which is true but says nothing useful.
      if (typeof args.output_path !== 'string' || !args.output_path.trim()) {
        throw new Error(`output_path must be a path, not ${typeof args.output_path}`);
      }
      const bytes = await apiThumbnail(args.letter_id);
      if (!bytes) return text({ error: 'needs the API', hint: apiUnavailable });
      mkdirSync(dirname(args.output_path), { recursive: true });
      // Any 200 used to count. A portal or proxy that answers with JSON or an
      // HTML error page was saved under the name of a thumbnail and reported as
      // one. PNG, JPEG and GIF are what the endpoint serves.
      const sig = bytes.subarray(0, 4).toString('latin1');
      if (!(sig.startsWith('\x89PNG') || sig.startsWith('\xff\xd8') || sig.startsWith('GIF8'))) {
        return text({ error: `the thumbnail endpoint did not answer with an image (${bytes.length} bytes)`, hint: 'the letter may not have one yet' });
      }
      writePrivate(args.output_path, bytes);
      return text({ transport: 'api', saved: args.output_path, bytes: bytes.length });
    }
    if (name === 'epost_list_storage') {
      const dirs = await apiListDirectories();
      if (dirs) {
        return text({
          transport: 'api',
          folders: dirs.filter(d => d.directoryId).map(d => ({ name: d.directoryName, count: d.numberOfDocuments, id: d.directoryId })),
          companyFolders: dirs.filter(d => !d.directoryId).map(d => ({ name: d.directoryName, count: d.numberOfDocuments })),
        });
      }
      const out = await listStorage(await p());
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_list_storage_documents') {
      // folder_id is an API concept; the portal lists everything. Falling
      // through with one set answered "all of Storage" to a question about one
      // folder, and the caller could not tell.
      if (args.folder_id) {
        const scoped = await apiArchiveWithFolders(1000);
        if (!scoped) return text({ error: 'folder_id needs the public API and it is unavailable', hint: redact(apiUnavailable || 'configure an API password or key'), note: 'drop folder_id to list the whole of Storage through the portal' });
      }
      const viaApi = args.folder_id
        ? await apiListArchive(args.folder_id, args.limit || 1000)
        : await apiArchiveWithFolders(args.limit || 1000);
      if (viaApi) {
        const items = Array.isArray(viaApi) ? viaApi : (viaApi.letters || viaApi.content || []);
        // A full page cannot be told from a complete archive, and presenting
        // one as the other is how a caller concludes a document is not there.
        const limit = args.limit || 1000;
        return text({
          transport: 'api', count: items.length, documents: items.map(apiLetterRow),
          ...(items.length >= limit ? { truncated: true, hint: `exactly ${limit} came back, so there may be more — raise limit` } : {}),
        });
      }
      const out = await listStorageDocuments(await p(), { scrollAll: args.scroll_all === true });
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_read_storage_document') {
      // Over the API a Storage document is just a letter with an id: the listing
      // already carries the description, and the same content endpoint serves
      // the PDF. No card to open, no viewer to drive.
      // folder_id and letter_id only mean anything to the API. Falling through to
      // the browser with either of them set silently re-reads the request as
      // "whatever is at that position in the whole of Storage" — a different
      // document, downloaded and reported as the one that was asked for.
      const apiOnly = args.folder_id || args.letter_id;
      const arch = await apiListArchive(args.folder_id, 1000);
      if (!arch && apiOnly) {
        return text({ error: 'this needs the public API and it is unavailable', hint: redact(apiUnavailable || 'configure an API password or key'), note: 'folder_id and letter_id cannot be honoured through the portal — drop them to read by position instead' });
      }
      if (arch) {
        const items = Array.isArray(arch) ? arch : (arch.letters || arch.content || []);
        const l = args.letter_id ? items.find(x => x.id === args.letter_id)
          : typeof args.index === 'number' ? items[args.index]
            : args.title ? oneByTitle(items, args.title) : null;
        // The API answered and there is no such document. Asking the browser the
        // same question with a different meaning of "index" is not a fallback.
        if (!l && apiOnly) {
          return text({ error: 'no such document in Storage', folder_id: args.folder_id ?? null, letter_id: args.letter_id ?? null });
        }
        if (l) {
          let saved = null;
          if (args.output_dir) {
            const bytes = await apiLetterContent(l.id);
            if (bytes) {
              mkdirSync(args.output_dir, { recursive: true });
              saved = join(args.output_dir, `${namePart((l.receivedDateTime || '').slice(0, 10) || 'undated')}_ePostStorage_${namePart(args.index ?? l.id)}.pdf`);
              // Correspondence: written with the process umask it can land
            // group- and world-readable.
            writePrivate(saved, bytes);
            }
          }
          // Same rule as the browser path: asking for the file and being told
          // "ok" with nothing saved is a wrong answer about half the request.
          if (args.output_dir && !saved) {
            return text({ transport: 'api', status: 'partial', ...apiLetterRow(l, args.index ?? 0), saved: null, error: 'the document content could not be fetched — the metadata below was read, the file was not saved' });
          }
          return text({ transport: 'api', ...apiLetterRow(l, args.index ?? 0), saved });
        }
      }
      const out = await readStorageDocument(await p(), { index: args.index, title: args.title, outputDir: args.output_dir });
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_create_folder') {
      const out = await createFolder(await p(), args.name);
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_unfile_from_folder') {
      const out = await moveToFolder(await p(), { index: args.index, title: args.title, folder: args.folder, add: false });
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_move_to_folder') {
      const out = await moveToFolder(await p(), { index: args.index, title: args.title, folder: args.folder, remove: args.remove_from || null });
      await saveState();
      if (out.status === 'login_required') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: redact('ERROR: ' + (e.message || String(e))) }], isError: true };
  } finally {
    // Whatever happened, the next caller gets the browser.
    releaseBrowser?.();
  }
});

// Close the browser when the server is told to stop. Without this a killed
// server leaves an orphaned Chrome holding the profile's SingletonLock, and the
// next start fails with "Failed to create a ProcessSingleton for your profile
// directory" — which reads like a corrupt profile and is really just a process
// nobody reaped. The self-heal in getContext exists because of that; this stops
// it happening in the first place.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    try { await ctx?.close(); } catch { /* going away regardless */ }
    process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
