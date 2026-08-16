import { useState } from 'react';
import { FIELD_LABELS, showText } from '../format.js';
import { CheckIcon, AlertIcon, ImageIcon } from './icons.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Label } from './ui/label.jsx';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent
} from './ui/accordion.jsx';

// Read-only diagnosis: what is wrong with the album (shown under "Analyze").
export function Diagnosis({ report }) {
  // Hard split = a tag split beets will actually create (blocks import, fixable
  // in step 2). Soft = mixed format/quality: advisory only, import still allowed.
  const hardSplit = report.groupCount > 1;
  const softSplit = report.mixedFormats || report.mixedQuality;
  const bannerClass = hardSplit ? 'bad' : softSplit ? 'warn' : 'good';
  const fmtQuality = (q) =>
    `${q.sampleRate ? `${q.sampleRate / 1000}kHz` : '?'}/${q.bitDepth || '?'}-bit ×${q.count}`;
  // Qualities arrive sorted by track count, so everything after the first is the
  // minority — the tracks to actually re-download.
  const oddQualityFiles = (report.qualities || []).slice(1).flatMap((q) => q.files || []);
  // "same extension" only reads correctly when there is exactly one.
  const singleFormat = report.formats?.length === 1 ? `.${report.formats[0]}` : null;

  return (
    <div className="report">
      <div className={`report-banner ${bannerClass}`}>
        {hardSplit || softSplit ? <AlertIcon /> : <CheckIcon />}
        <span>
          {report.groupCount > 1
            ? `This album would split into ${report.groupCount} albums. Cause: ${report.splitFields
                .map((f) => FIELD_LABELS[f] || f)
                .join(', ')}.`
            : report.mixedFormats
              ? 'Tags are consistent, but mixed audio formats could split this album — import allowed, see below.'
              : report.mixedQuality
                ? 'Tags are consistent, but mixed audio quality (sample rate / bit depth) could split this album — import allowed, see below.'
                : `Grouping consistent — stays as 1 album (${report.trackCount} tracks).`}
        </span>
      </div>

      {report.unreadable?.length ? (
        <div className="report-banner bad">
          <AlertIcon />
          <span>
            {report.unreadable.length} file{report.unreadable.length > 1 ? 's' : ''} could not be
            read ({report.unreadable.join(', ')}) — usually a truncated or corrupt download. They
            are left out of the tag and quality checks here, and no fix can repair them: re-download
            them before importing.
          </span>
        </div>
      ) : null}

      {report.incomplete ? (
        <div className="report-banner bad">
          <AlertIcon />
          <span>
            Missing tracks:{' '}
            {report.trackGaps
              .map((g) => `disc ${g.disc} → ${g.missing.map((n) => `#${n}`).join(', ')}`)
              .join('; ')}
            . Add them before importing.
          </span>
        </div>
      ) : null}

      {report.noDuration?.length ? (
        <div className="report-banner bad">
          <AlertIcon />
          <span>
            {report.noDuration.length} of {report.trackCount} tracks report no length. The audio
            plays, but nothing downstream can read how long it is: Navidrome draws a dead progress
            bar, and beets scores the track at maximum length distance and gives up on matching the
            album. Usually a transcode from a stream whose length was unknown at the time.{' '}
            {report.durationRepairable?.length
              ? 'Tick “Restore missing track length” in step 2 — the re-encode is lossless.'
              : 'Not repairable here without re-encoding a lossy format, which would cost quality.'}
          </span>
        </div>
      ) : null}

      {report.missingRequired?.length ? (
        <div className="report-banner warn">
          <AlertIcon />
          <span>
            {report.missingRequired
              .map(
                (m) =>
                  `${m.files.length} track${m.files.length > 1 ? 's' : ''} with no ${
                    m.field === 'album_artist' ? 'album artist' : m.field
                  }`
              )
              .join(', ')}
            . Step 2 cannot fill these in — the values are not in the files. The import can:
            beets matches the album online and writes back what it finds. Import and check the
            result; if the tracks still land blank, beets found no match and they need tagging
            by hand.
          </span>
        </div>
      ) : null}

      {report.art?.hasMissing ? (
        <div className="report-banner warn">
          <ImageIcon />
          <span>
            No embedded cover art in {report.art.missing} of {report.art.total} track
            {report.art.total > 1 ? 's' : ''}.
            {report.art.folderImages.length
              ? ` A cover file is in the folder (${report.art.folderImages.join(', ')}) but not embedded.`
              : ''}{' '}
            Upload one in step 2 to embed it into every track.
          </span>
        </div>
      ) : null}

      {report.mixedQuality ? (
        <div className="report-banner warn">
          <AlertIcon />
          <span>
            Mixed audio quality ({report.qualities.map(fmtQuality).join(', ')})
            {singleFormat ? ` — same ${singleFormat} extension, but` : ' —'} different sample rate /
            bit depth. This can make Navidrome split the album (though a single odd track often stays
            merged). You can still import; to be safe, re-download the odd tracks at the album's
            quality or resample to one spec. No tag fix repairs this.
            {oddQualityFiles.length ? ` Odd tracks: ${oddQualityFiles.join(', ')}.` : ''}
          </span>
        </div>
      ) : null}

      {report.textIssues.length ? (
        <div className="report-banner warn">
          <AlertIcon />
          <span>
            {report.textIssues.length} corrupted/dirty tag{report.textIssues.length > 1 ? 's' : ''} found
            (downloader damage). Tick “Repair corrupted text” in step 2 to auto-fix the confident ones.
          </span>
        </div>
      ) : null}

      {report.multiDisc ? (
        <p className="muted small">
          Multi-disc set ({report.discs.length} discs):{' '}
          {report.discs
            .map((d) => `disc ${d.disc} = ${d.trackCount} tracks${d.contiguous ? '' : ' ⚠ gaps'}`)
            .join(', ')}
          . Leave Disc blank in step 2 — do not unify it.
        </p>
      ) : null}

      {report.mixedFormats ? (
        <div className="report-banner warn">
          <AlertIcon />
          <span>
            Mixed audio formats ({report.formats.join(', ')}) — this can make Navidrome split the
            album. You can still import; to be safe, convert the odd files to one format (or remove
            them) and re-upload. No tag fix repairs this.
          </span>
        </div>
      ) : null}

      {report.textIssues.length || report.filenameIssues.length ? (
        <Accordion type="single" collapsible className="border-t border-border">
          {report.textIssues.length ? (
            <AccordionItem value="text-issues">
              <AccordionTrigger>Tag text issues ({report.textIssues.length})</AccordionTrigger>
              <AccordionContent>
                <ul className="list-disc space-y-1 pl-5">
                  {report.textIssues.map((issue, idx) => (
                    <li key={`${issue.file}-${issue.field}-${idx}`}>
                      <code>{issue.field}</code> · {issue.file}: “{showText(issue.display)}” → “
                      {showText(issue.suggested)}”
                      {issue.confident ? '' : ' ⚠ manual (ambiguous)'}
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ) : null}

          {report.filenameIssues.length ? (
            <AccordionItem value="filename-fixes" className="border-b-0">
              <AccordionTrigger>Filename fixes ({report.filenameIssues.length})</AccordionTrigger>
              <AccordionContent>
                <ul className="list-disc space-y-1 pl-5">
                  {report.filenameIssues.map((issue) => (
                    <li key={issue.file}>
                      {issue.file} → {issue.suggested}
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ) : null}
        </Accordion>
      ) : null}
    </div>
  );
}

// The remedy form: unify fields and toggle the auto-fixes (shown under "Fix").
export function FixForm({ report, draft, onDraftChange }) {
  return (
    <div className="report">
      <table className="field-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Status</th>
            <th>Distinct values</th>
            <th>Unify to</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(FIELD_LABELS).map((field) => {
            const info = report.fields[field];
            if (!info) {
              return null;
            }
            const valueSummary = info.distinct.length
              ? info.distinct.map((d) => `${d.value} ×${d.count}`).join('  |  ')
              : '(empty)';
            return (
              <tr key={field} className={info.consistent ? '' : 'row-bad'}>
                <td>{FIELD_LABELS[field]}</td>
                <td>{info.consistent ? 'OK' : info.variantOnly ? 'variant — safe merge' : `${info.distinct.length || 0} values${info.missing ? `, ${info.missing} missing` : ''}`}</td>
                <td className="value-cell">{valueSummary}</td>
                <td>
                  <Input
                    type="text"
                    className="min-w-[120px] text-sm"
                    value={draft[field] ?? ''}
                    placeholder={info.proposed || (field === 'date' ? 'YYYY-MM-DD' : '(leave blank to skip)')}
                    onChange={(event) => onDraftChange(field, event.target.value)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="report-extras">
        <div className="flex items-center gap-2">
          <Checkbox
            id="normalizeTracks"
            checked={draft.normalizeTracks}
            onCheckedChange={(value) => onDraftChange('normalizeTracks', value === true)}
          />
          <Label htmlFor="normalizeTracks" className="cursor-pointer font-normal">
            Normalize track numbering (set totals to {report.trackCount})
            {report.track.needsNormalize ? ' — needed' : ' — already OK'}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="fixFilenames"
            checked={draft.fixFilenames}
            onCheckedChange={(value) => onDraftChange('fixFilenames', value === true)}
          />
          <Label htmlFor="fixFilenames" className="cursor-pointer font-normal">
            Fix apostrophes in filenames
            {report.filenameIssues.length ? ` (${report.filenameIssues.length})` : ' — none found'}
          </Label>
        </div>
        {report.noDuration?.length ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="repairDuration"
              disabled={!report.durationRepairable?.length}
              checked={draft.repairDuration}
              onCheckedChange={(value) => onDraftChange('repairDuration', value === true)}
            />
            <Label htmlFor="repairDuration" className="cursor-pointer font-normal">
              Restore missing track length ({report.durationRepairable.length} of{' '}
              {report.noDuration.length})
              {report.durationRepairable.length < report.noDuration.length
                ? ' — the rest are not FLAC, and re-encoding them would cost quality'
                : ' — re-encodes the audio, losslessly'}
            </Label>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Checkbox
            id="repairText"
            checked={draft.repairText}
            onCheckedChange={(value) => onDraftChange('repairText', value === true)}
          />
          <Label htmlFor="repairText" className="cursor-pointer font-normal">
            Repair corrupted text in tags
            {report.textIssues.length ? ` (${report.textIssues.length})` : ' — none found'}
          </Label>
        </div>
      </div>
    </div>
  );
}

// Pick the MusicBrainz release to import as.
//
// beets scores a candidate mostly on how well the track titles line up, so the
// albums that most need correct titles are the ones it refuses to match: an
// album with none scores far past the auto-apply threshold against its own
// exact release. Naming the release is the way past that, and it has to be a
// person doing the naming — the whole reason beets declined is that the
// evidence in the files is too thin to decide on.
export function ReleasePicker({ report, releases, chosen, query, onQueryChange, onSearch, onChoose, busy }) {
  if (!report) {
    return null;
  }

  const chosenRelease = releases?.find((r) => r.id === chosen) || null;

  return (
    <div className="report">
      {/* Searching on the album's own tags fails exactly where this feature is
          needed most: an album that arrived untagged has nothing to search on.
          Typing the two fields here beats filling them in at step 2, which
          would write a guess into every file just to ask a question. */}
      <div className="cover-controls">
        <Input
          type="text"
          className="min-w-[160px] text-sm"
          value={query?.artist ?? ''}
          placeholder={report.fields.album_artist?.proposed || 'artist'}
          onChange={(event) => onQueryChange('artist', event.target.value)}
        />
        <Input
          type="text"
          className="min-w-[160px] text-sm"
          value={query?.album ?? ''}
          placeholder={report.fields.album?.proposed || 'album'}
          onChange={(event) => onQueryChange('album', event.target.value)}
        />
      </div>

      <div className="cover-controls">
        <Button type="button" size="sm" variant="secondary" onClick={onSearch} disabled={Boolean(busy)}>
          {busy === 'releases' ? 'Searching…' : releases ? 'Search again' : 'Find on MusicBrainz'}
        </Button>
        {chosen ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onChoose(null)}>
            Clear choice
          </Button>
        ) : null}
      </div>

      <p className="step-status">
        {chosenRelease
          ? `Importing as “${chosenRelease.title}” (${chosenRelease.date || 'no date'}) — beets will overwrite the tags with this release's.`
          : releases
            ? 'Pick the release this album is, or leave unpicked to let beets decide.'
            : 'Optional. Use this when beets imports the album as-is instead of correcting it — usually because the tracks have no titles to match on.'}
      </p>

      {releases?.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {releases.map((r) => (
            <li key={r.id}>
              <label className="cursor-pointer">
                <input
                  type="radio"
                  name="release"
                  className="mr-2"
                  checked={chosen === r.id}
                  onChange={() => onChoose(r.id)}
                />
                <strong>{r.artist || '(unknown artist)'}</strong> — {r.title}
                {r.disambiguation ? ` (${r.disambiguation})` : ''}
                <span className="muted small">
                  {' · '}
                  {[
                    r.date || 'no date',
                    r.country,
                    r.format,
                    `${r.trackCount} tracks`,
                    r.label,
                    r.catalogNumber
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {r.matchesTrackCount ? '' : ' · ⚠ track count differs'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Cover art embed: only shown when at least one track is missing a cover — when
// every track already has art there is nothing to fix, so the menu stays hidden.
export function CoverArtFix({ report, onEmbed, busy }) {
  const [file, setFile] = useState(null);
  // Bumped after an embed to remount (and thus clear) the file input.
  const [resetKey, setResetKey] = useState(0);
  const art = report.art;
  if (!art?.hasMissing) {
    return null;
  }

  async function handleEmbed() {
    if (!file) {
      return;
    }
    await onEmbed(file);
    setFile(null);
    setResetKey((key) => key + 1);
  }

  return (
    <div className="report cover-fix">
      <p className="step-status">
        {art.withArt}/{art.total} tracks have embedded art — {art.missing} missing. Upload a cover to
        embed it into every track.
      </p>
      <div className="cover-controls">
        <Input
          key={resetKey}
          type="file"
          accept="image/*"
          className="flex-1 min-w-0 cursor-pointer"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
        />
        <Button type="button" size="sm" onClick={handleEmbed} disabled={!file || Boolean(busy)}>
          {busy === 'cover' ? 'Embedding…' : 'Embed cover'}
        </Button>
      </div>
    </div>
  );
}
