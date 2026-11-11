// The pure half of the MusicBrainz release lookup: how a search is phrased and
// how an answer is read. The request itself stays with whoever makes it (see
// server/musicbrainz.js, which also explains why the lookup exists).

// Lucene metacharacters in a quoted phrase would otherwise make the query fail
// to parse — album names with brackets or a colon are common enough to matter.
function luceneEscape(value) {
  return String(value).replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

export function buildQuery({ artist, album, tracks }) {
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

export function summarize(release, expectedTracks) {
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

// Same track count first — the strongest cheap signal that this is the same
// edition — then MusicBrainz's own relevance order within each group.
export function sortCandidates(candidates) {
  candidates.sort((a, b) => Number(b.matchesTrackCount) - Number(a.matchesTrackCount));
}
