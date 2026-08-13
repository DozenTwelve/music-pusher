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

// Lucene metacharacters in a quoted phrase would otherwise make the query fail
// to parse — album names with brackets or a colon are common enough to matter.
function luceneEscape(value) {
  return String(value).replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

function buildQuery({ artist, album, tracks }) {
  const terms = [`release:"${luceneEscape(album)}"`];
  if (artist) {
    terms.push(`artist:"${luceneEscape(artist)}"`);
  }
  // A soft signal, deliberately not a filter: a release whose track count
  // differs is usually a different edition rather than a wrong album, and the
  // user is the one deciding. It only nudges the ranking.
  if (Number.isInteger(tracks) && tracks > 0) {
    terms.push(`tracks:${tracks}`);
  }
  return terms.join(' AND ');
}

function summarize(release, expectedTracks) {
  const media = Array.isArray(release.media) ? release.media : [];
  const trackCount = media.reduce((sum, m) => sum + (m['track-count'] || 0), 0);
  const credit = Array.isArray(release['artist-credit']) ? release['artist-credit'] : [];
  const labels = Array.isArray(release['label-info']) ? release['label-info'] : [];

  return {
    id: release.id,
    title: release.title || '',
    artist: credit.map((c) => c.name || c.artist?.name || '').filter(Boolean).join(', '),
    date: release.date || '',
    country: release.country || '',
    trackCount,
    // Surfaced so the user can tell two same-titled editions apart at a glance —
    // which is the whole point of showing them a list.
    disambiguation: release.disambiguation || '',
    format: media.map((m) => m.format).filter(Boolean).join(' + '),
    label: labels.map((l) => l.label?.name).filter(Boolean).join(', '),
    catalogNumber: labels.map((l) => l['catalog-number']).filter(Boolean).join(', '),
    matchesTrackCount: expectedTracks == null || trackCount === expectedTracks
  };
}

export async function searchReleases({ artist, album, tracks }) {
  if (!album || String(album).trim() === '') {
    return { ok: false, code: 'no_album_name', message: 'The album has no album tag to search on.' };
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

  // Same track count first — the strongest cheap signal that this is the same
  // edition — then MusicBrainz's own relevance order within each group.
  candidates.sort((a, b) => Number(b.matchesTrackCount) - Number(a.matchesTrackCount));

  return { ok: true, query: { artist, album, tracks }, candidates };
}
