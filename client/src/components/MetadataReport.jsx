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
  const splitDanger = report.groupCount > 1 || report.mixedFormats;

  return (
    <div className="report">
      <div className={`report-banner ${splitDanger ? 'bad' : 'good'}`}>
        {splitDanger ? <AlertIcon /> : <CheckIcon />}
        <span>
          {report.groupCount > 1
            ? `This album would split into ${report.groupCount} albums. Cause: ${report.splitFields
                .map((f) => FIELD_LABELS[f] || f)
                .join(', ')}.`
            : report.mixedFormats
              ? 'Tags are consistent, but mixed audio formats would still split this album.'
              : `Grouping consistent — stays as 1 album (${report.trackCount} tracks).`}
        </span>
      </div>

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
        <div className="report-banner bad">
          <AlertIcon />
          <span>
            Mixed audio formats ({report.formats.join(', ')}) — Navidrome splits an album whose
            tracks differ in format. Convert the odd files to one format (or remove them) and
            re-upload; tag fixes cannot repair this.
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
                <td>{info.consistent ? 'OK' : `${info.distinct.length || 0} values${info.missing ? `, ${info.missing} missing` : ''}`}</td>
                <td className="value-cell">{valueSummary}</td>
                <td>
                  <Input
                    type="text"
                    className="min-w-[120px] text-sm"
                    value={draft[field] ?? ''}
                    placeholder={info.proposed || '(leave blank to skip)'}
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
