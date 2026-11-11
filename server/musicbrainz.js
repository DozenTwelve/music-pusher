// Release lookup for the case beets cannot decide on its own.
//
// beets scores a candidate mostly on how well the track titles line up, so an
// album that arrives with no titles scores badly against the very release that
// would supply them — the album that prompted this scored 0.33 against its own
// exact MusicBrainz release, against a 0.04 threshold, and a quiet import can
// only fall back to importing it as-is. The way out is a human confirming which
// release it is; this module is what gives them the list to confirm from.
//
// Only the search endpoint is used. Applying the release is still beets' job,
// via `--search-id` — nothing here writes a tag.

import net from 'node:net';
import { buildQuery, summarize, sortCandidates } from '../shared/musicbrainz.js';

// The deployment box resolves musicbrainz.org to both an A and a AAAA record but
// has no working route to the IPv6 one, so a connection that starts there stalls
// until it times out. Node already runs Happy Eyeballs by default, but its
// 250ms head start is not enough here — the IPv4 attempt never gets going and
// `fetch` fails with ETIMEDOUT while curl on the same host succeeds. 500ms is.
//
// Set globally because `fetch` takes no per-request connection options: Node
// does not expose undici's dispatcher, so this setter is the only reachable
// knob. It is also the right shape of fix — raising the fallback delay keeps
// IPv6 preferred where it works, unlike pinning the family to IPv4.
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

const MB_ENDPOINT = 'https://musicbrainz.org/ws/2/release';
// MusicBrainz requires a contactable User-Agent and throttles to ~1 req/s. This
// runs once per button press, so the rate limit needs no client-side pacing.
const USER_AGENT = 'music-pusher/0.1 ( https://github.com/ )';
const TIMEOUT_MS = 20000;
const MAX_RESULTS = 8;

export async function searchReleases({ artist, album, tracks }) {
  if (!album || String(album).trim() === '') {
    return {
      ok: false,
      code: 'no_album_name',
      message: 'Nothing to search on: the album has no album tag. Type the album name above.'
    };
  }

  const url = new URL(MB_ENDPOINT);
  url.searchParams.set('query', buildQuery({ artist, album, tracks }));
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('limit', String(MAX_RESULTS));

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach MusicBrainz: ${error.message}`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'bad_response',
      message: `MusicBrainz answered ${response.status}.`
    };
  }

  const body = await response.json();
  const releases = Array.isArray(body.releases) ? body.releases : [];
  const expected = Number.isInteger(tracks) && tracks > 0 ? tracks : null;
  const candidates = releases.map((r) => summarize(r, expected));

  sortCandidates(candidates);

  return { ok: true, query: { artist, album, tracks }, candidates };
}
