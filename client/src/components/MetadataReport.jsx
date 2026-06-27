import { FIELD_LABELS, showText } from '../format.js';

export default function MetadataReport({ report, draft, onDraftChange }) {
  const splitDanger = report.groupCount > 1;

  return (
    <div className="report">
      <div className={`report-banner ${splitDanger ? 'bad' : 'good'}`}>
        {splitDanger
          ? `⚠ This album would split into ${report.groupCount} albums. Cause: ${report.splitFields
              .map((f) => FIELD_LABELS[f] || f)
              .join(', ')}.`
          : `✓ Grouping consistent — stays as 1 album (${report.trackCount} tracks). See below for any other issues.`}
      </div>

      {report.incomplete ? (
        <div className="report-banner bad">
          ⚠ Missing tracks:{' '}
          {report.trackGaps
            .map((g) => `disc ${g.disc} → ${g.missing.map((n) => `#${n}`).join(', ')}`)
            .join('; ')}
          . Add them before importing.
        </div>
      ) : null}

      {report.textIssues.length ? (
        <div className="report-banner warn">
          {report.textIssues.length} corrupted/dirty tag{report.textIssues.length > 1 ? 's' : ''} found
          (downloader damage). Tick “Repair corrupted text” below to auto-fix the confident ones.
        </div>
      ) : null}

      {report.multiDisc ? (
        <p className="muted">
          Multi-disc set ({report.discs.length} discs):{' '}
          {report.discs
            .map((d) => `disc ${d.disc} = ${d.trackCount} tracks${d.contiguous ? '' : ' ⚠ gaps'}`)
            .join(', ')}
          . Leave Disc blank below — do not unify it.
        </p>
      ) : null}

      {report.formats.length > 1 ? (
        <p className="muted">Mixed formats present: {report.formats.join(', ')}</p>
      ) : null}

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
                  <input
                    type="text"
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
        <label>
          <input
            type="checkbox"
            checked={draft.normalizeTracks}
            onChange={(event) => onDraftChange('normalizeTracks', event.target.checked)}
          />
          Normalize track numbering (set totals to {report.trackCount})
          {report.track.needsNormalize ? ' — needed' : ' — already OK'}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.fixFilenames}
            onChange={(event) => onDraftChange('fixFilenames', event.target.checked)}
          />
          Fix apostrophes in filenames
          {report.filenameIssues.length ? ` (${report.filenameIssues.length})` : ' — none found'}
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.repairText}
            onChange={(event) => onDraftChange('repairText', event.target.checked)}
          />
          Repair corrupted text in tags
          {report.textIssues.length ? ` (${report.textIssues.length})` : ' — none found'}
        </label>
      </div>

      {report.textIssues.length ? (
        <details>
          <summary>Tag text issues ({report.textIssues.length})</summary>
          <ul>
            {report.textIssues.map((issue, idx) => (
              <li key={`${issue.file}-${issue.field}-${idx}`}>
                <code>{issue.field}</code> · {issue.file}: “{showText(issue.display)}” → “
                {showText(issue.suggested)}”
                {issue.confident ? '' : ' ⚠ manual (ambiguous)'}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {report.filenameIssues.length ? (
        <details>
          <summary>Filename fixes ({report.filenameIssues.length})</summary>
          <ul>
            {report.filenameIssues.map((issue) => (
              <li key={issue.file}>
                {issue.file} → {issue.suggested}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
