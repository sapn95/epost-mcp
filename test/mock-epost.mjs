// A stand-in for api.epost.ch, so the API layer can be exercised without going
// near the real account. Speaks the shapes the real service returns, including
// the awkward ones: the archive listing carries no folder field, folder names
// come back NFD-normalised, and /archive refuses a letter that is already in
// Storage.
import { createServer } from 'node:http';

export const DIRECTORIES = [
  { directoryId: 'dir-one', directoryName: 'Example_Alpha', numberOfDocuments: 2, hasSubDirectories: false },
  // deliberately NFD: the umlaut is a + combining diaeresis, as the service sends it
  { directoryId: 'dir-two', directoryName: 'Example_Ümlaut', numberOfDocuments: 1, hasSubDirectories: false },
  { directoryId: '', directoryName: 'ePost Scancenter', numberOfDocuments: 3, hasSubDirectories: false },
];

const letter = (id, over = {}) => ({
  id,
  letterTitle: 'Gescannter Brief',
  fileName: `${id}.pdf`,
  documentTypes: ['Invoice'],
  letterContentReference: `/epost/v2/letters/${id}/content`,
  letterType: 'CLASSIC_LETTER',
  receivedDateTime: '2020-02-02T11:02:37.275Z',
  description: 'Invoice from Someone AG',
  readStatus: 'UNREAD',
  ...over,
});

// As long as a real one. A seven-character stand-in slipped under the
// redactor's minimum length, which is there so that ordinary short words are
// not mangled — and a test that cannot trip the redactor proves nothing.
export const API_KEY = 'k-123';
export const TOKEN = 'tok-abcdefghijklmnopqrstuvwxyz0123456789';

// Read a request body, then hand it over. The mock used to answer before the
// body had arrived at all, which is why nothing it contained was ever checked.
const readBody = (req, then) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => then(raw));
};
const readForm = (req, then) => readBody(req, raw => then(new URLSearchParams(raw)));

export function start() {
  const state = {
    inbox: [
      letter('inbox-1'), letter('inbox-2', { description: null, readStatus: 'READ' }),
      // The file name is built from what the service says. A service that says
      // something path-shaped must not decide where the file lands.
      letter('inbox-3', { receivedDateTime: '../../../../tmp/pwned' }),
    ],
    archive: [letter('arch-1'), letter('arch-2', { description: null }), letter('arch-3')],
    inFolder: { 'dir-one': ['arch-1'], 'dir-two': ['arch-3'] },   // arch-2 is unfiled
    deleted: [letter('del-1')],
    calls: [],
    echoPassword: 'test-password',   // what the fake gateway above quotes back
    echoToken: TOKEN,
  };

  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    state.calls.push(`${req.method} ${p}`);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const auth = req.headers.authorization || '';
    const key = req.headers['x-api-key'];

    // The grant used to accept anything at all, so a server that sent no
    // username, the wrong grant_type or no tenant still passed every
    // authentication test here and failed against the real service.
    if (p === '/core/latest/tenants' && req.method === 'POST') {
      return readForm(req, form => {
        if (!form.get('username') || !form.get('password')) return send(400, { error: 'invalid_request' });
        send(200, [{ tenant_id: 't-1', company_id: 0, company_name: 'Test' }]);
      });
    }
    if (p === '/core/latest/token' && req.method === 'POST') {
      return readForm(req, form => {
        if (form.get('grant_type') !== 'password') return send(400, { error: 'unsupported_grant_type' });
        if (!form.get('username') || !form.get('password')) return send(400, { error: 'invalid_request' });
        if (form.get('tenant_id') !== 't-1') return send(400, { error: 'invalid_tenant' });
        send(200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 600, refresh_expires_in: 1800 });
      });
    }
    // everything below needs one of the two documented schemes
    // The exact token, or the exact key. Accepting anything non-empty meant a
    // server that sent a malformed header — or the wrong credential entirely —
    // passed the whole suite and failed against ePost.
    if (auth !== `Bearer ${TOKEN}` && key !== API_KEY) return send(401, { error: 'unauthorized' });

    // A gateway that quotes the request it rejected, credentials and all. Real
    // proxies do this, and the body reaches the model through a tool result.
    if (p === '/epost/v2/letters/echo-secret') {
      return send(500, {
        error: 'upstream rejected the request',
        sent: { password: state.echoPassword, authorization: `Bearer ${state.echoToken}` },
      });
    }
    if (p === '/epost/v2/letters' && req.method === 'GET') return send(200, state.inbox);
    if (p === '/epost/v2/letters/deleted') return send(200, state.deleted);
    if (p === '/epost/v2/letters/inbox/count') return send(200, { count: state.inbox.filter(l => l.readStatus === 'UNREAD').length });
    if (p === '/epost/v2/letters/search') {
      const k = (url.searchParams.get('keyword') || '').toLowerCase();
      return send(200, [...state.inbox, ...state.archive].filter(l => JSON.stringify(l).toLowerCase().includes(k)));
    }
    // It answered 204 to anything and changed nothing, so a set_read_status
    // that sent the wrong ids — or none — passed on its own echo.
    if (p === '/epost/v2/letters/read' && req.method === 'POST') {
      return readBody(req, raw => {
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'bad_json' }); }
        const ids = body.letterIds || body.ids || body.letter_ids;
        if (!Array.isArray(ids) || !ids.length) return send(400, { error: 'no_ids' });
        const status = body.readStatus || body.status;
        if (status !== 'READ' && status !== 'UNREAD') return send(400, { error: 'bad_status' });
        for (const l of state.inbox) if (ids.includes(l.id)) l.readStatus = status;
        send(204, '');
      });
    }
    if (p === '/epost/v2/archives/directories') return send(200, DIRECTORIES);
    if (p === '/epost/v2/archives/letters') {
      const d = url.searchParams.get('directory-id');
      if (d) return send(200, state.archive.filter(l => (state.inFolder[d] || []).includes(l.id)));
      return send(200, state.archive);           // note: no folder field, like the real one
    }
    const m = /^\/epost\/v2\/letters\/([^/]+)(\/.*)?$/.exec(p);
    if (m) {
      const [, id, tail] = m;
      // Deleted letters are addressable too — restoring one is the whole point.
      const known = [...state.inbox, ...state.archive, ...state.deleted].find(l => l.id === id);
      if (!known) return send(404, { error: 'not_found' });
      // The id goes in the bytes: identical content for every letter meant a
      // download that fetched the wrong one was indistinguishable from a
      // correct one.
      if (tail === '/content') return send(200, Buffer.from(`%PDF-1.4 mock ${id}`), 'application/octet-stream');
      // The real eight PNG magic bytes. Written as a string, "\x89" goes out as
      // two UTF-8 bytes and the fixture served something that was not a PNG at
      // all — which a caller checking the signature would rightly reject.
      if (tail === '/thumbnail') {
        return send(200, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(' mock')]), 'image/png');
      }
      // A real restore moves the letter. Answering 204 and changing nothing let
      // an implementation that restores no letter at all pass its test.
      if (tail === '/restore' && req.method === 'POST') {
        if (!state.deleted.some(l => l.id === id)) return send(400, { error: 'not_deleted' });
        state.deleted = state.deleted.filter(l => l.id !== id);
        state.inbox.push(known);
        return send(204, '');
      }
      if (tail === '/archive' && req.method === 'PATCH') {
        if (state.archive.some(l => l.id === id)) {
          return send(400, { error: 'bad_request', error_description: 'Letter is already archived!' });
        }
        const dir = url.searchParams.get('destination-directory-id');
        state.inbox = state.inbox.filter(l => l.id !== id);
        state.archive.push(known);
        if (dir) state.inFolder[dir] = [...(state.inFolder[dir] || []), id];
        return send(204, '');
      }
      if (!tail && req.method === 'GET') return send(200, known);
      if (!tail && req.method === 'DELETE') {
        state.inbox = state.inbox.filter(l => l.id !== id);
        state.archive = state.archive.filter(l => l.id !== id);
        if (!state.deleted.some(l => l.id === id)) state.deleted.push(known);
        return send(204, '');
      }
    }
    return send(404, { error: 'no_route', path: p });
  });

  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${srv.address().port}`,
      state,
      close: () => new Promise(r => srv.close(r)),
    }));
  });
}
