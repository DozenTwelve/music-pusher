import { useEffect, useState } from 'react';
import { getPreflight, errorMessage } from '../api.js';

// Host-readiness banner. Fetches /api/preflight once on mount and shows only the
// checks that need attention. When every check is ok it renders nothing at all —
// a healthy install stays quiet by design.
export default function PreflightBanner() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getPreflight()
      .then((data) => !cancelled && setReport(data))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="preflight preflight-fail" role="alert">
        <strong>Could not run preflight checks.</strong> {error}
      </div>
    );
  }

  if (!report) {
    return null;
  }

  const problems = report.checks.filter((check) => check.level !== 'ok');
  if (problems.length === 0) {
    return null;
  }

  const tone = report.ok ? 'preflight-warn' : 'preflight-fail';
  const heading = report.ok
    ? 'Some things need a look before this runs smoothly'
    : 'Missing requirements — imports will fail until these are fixed';

  return (
    <div className={`preflight ${tone}`} role="alert">
      <strong>{heading}</strong>
      <ul>
        {problems.map((check) => (
          <li key={check.id} className={`preflight-item preflight-${check.level}`}>
            <span className="preflight-label">{check.label}</span>
            <span className="preflight-detail">{check.detail}</span>
            {check.hint ? <span className="preflight-hint">{check.hint}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
