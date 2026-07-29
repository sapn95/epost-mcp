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
    // Statuses to answer the next calls with, one entry per call, so a test can
    // reproduce the awkward moments a happy mock never produces: a token that
    // expired between two requests, one endpoint failing while its neighbours
    // work, a re-authentication that no longer takes. An entry without a `path`
    // applies to the next letterbox call and deliberately NOT to the two auth
    // endpoints — otherwise a queued failure would be eaten by the refresh the
    // first one provokes.
    forceStatus: [],                 // [{ status, path? }]
    // A gateway that answers a thumbnail request with an error PAGE, 200 and
    // all. Any 200 used to be saved under the thumbnail's name.
    thumbnailAsHtml: false,
    // The same gateway on the endpoint that serves the correspondence itself.
    // The thumbnail grew a signature check two rounds ago and this one never
    // did, so an error page was written to a .pdf and reported as the letter,
    // with a byte count beside it. Nothing here could produce it: the content
    // route has only ever served a PDF.
    contentAsHtml: false,
    // The same endpoint answering 200 with nothing in it — a gateway that
    // truncates, or a 204, which looks identical from here because a raw fetch
    // reads the body before anyone looks at the status. It is the one answer
    // the signature check above cannot catch, because that check flags a bad
    // answer by its LENGTH and zero is a falsy length, so an empty body was
    // saved and reported as a letter with `bytes: 0` beside it.
    contentEmpty: false,
    // One folder that cannot be listed while its neighbours can. The archive
    // listing carries no folder field, so membership is derived by asking each
    // folder what it holds — and when one of those calls fails, the documents
    // it would have named have an UNKNOWN membership rather than none. Nothing
    // could produce that here before, so the branch that distinguishes the two
    // went untested. forceStatus cannot express it: every folder listing uses
    // the same path, so a queued failure lands on whichever call comes first.
    failDirectoryId: null,
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

    // Queued failures, consumed one per matching call — see state.forceStatus.
    const AUTH = ['/core/latest/tenants', '/core/latest/token'];
    const forced = state.forceStatus.findIndex(f => (f.path ? f.path === p : !AUTH.includes(p)));
    if (forced >= 0) {
      const [f] = state.forceStatus.splice(forced, 1);
      return send(f.status, { error: 'forced', path: p });
    }

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
    // `limit` is honoured, because the server's own answers turn on it: it asks
    // for a window and then reads the edge of that window as the edge of the
    // letterbox. A mock that handed back everything however little was asked for
    // could not produce a full page at all, so the difference between "the letter
    // is not in the inbox" and "the letter was not in this answer" was untestable
    // — and both came out as the former.
    if (p === '/epost/v2/letters' && req.method === 'GET') {
      const n = Number(url.searchParams.get('limit'));
      return send(200, n > 0 ? state.inbox.slice(0, n) : state.inbox);
    }
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
    // `limit` is honoured here too. The inbox listing was taught to last round,
    // because the server reads the edge of the window it asked for as the edge
    // of the letterbox — and the archive listing, which the Storage tools read
    // exactly the same way, was left handing back everything however little was
    // asked for. A full page could therefore never occur, and "no such document
    // in Storage" about a document sitting in it could not be caught.
    if (p === '/epost/v2/archives/letters') {
      const d = url.searchParams.get('directory-id');
      const n = Number(url.searchParams.get('limit'));
      const cap = xs => (n > 0 ? xs.slice(0, n) : xs);
      if (d && d === state.failDirectoryId) return send(503, { error: 'directory_unavailable' });
      if (d) return send(200, cap(state.archive.filter(l => (state.inFolder[d] || []).includes(l.id))));
      return send(200, cap(state.archive));      // note: no folder field, like the real one
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
      if (tail === '/content') {
        if (state.contentEmpty) return send(200, Buffer.alloc(0), 'application/pdf');
        if (state.contentAsHtml) return send(200, '<html><body>gateway error</body></html>', 'text/html');
        return send(200, Buffer.from(`%PDF-1.4 mock ${id}`), 'application/octet-stream');
      }
      // The real eight PNG magic bytes. Written as a string, "\x89" goes out as
      // two UTF-8 bytes and the fixture served something that was not a PNG at
      // all — which a caller checking the signature would rightly reject.
      if (tail === '/thumbnail') {
        if (state.thumbnailAsHtml) return send(200, '<html><body>gateway error</body></html>', 'text/html');
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
