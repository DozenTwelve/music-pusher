import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';

// Runtime counterpart to scripts/doctor.sh: the same host checks, but served to
// the UI so the homepage can warn when a required tool or path is missing.
//
// Levels:
//   fail — a hard requirement is missing; the app cannot do its job.
//   warn — degraded or unverified; the app may still work.
//   ok   — verified good. The UI hides the banner only when EVERY check is ok.

// Run a binary's version command with a hard timeout. A wedged tool (say a
// wrapper at BEET_BIN that blocks on stdin) would otherwise hang this endpoint
// forever, since a probe only settles on close/error. We spawn here rather than
// reuse the shared runProcess so the timeout stays scoped to preflight and never
// touches long-running import/fix work. Outcomes are kept distinct so callers can
// tell "could not launch" (missing/not executable) from "launched but exited
// non-zero" (present but broken) — collapsing them mislabels a broken tool as
// absent and sends the user down the wrong fix path.
const PROBE_TIMEOUT_MS = 5000;

function runVersion(bin, args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      shell: false,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // 'error' fires when the tool cannot be launched at all (missing binary, no
    // exec permission) — distinct from a launched process that exits non-zero.
    proc.on('error', () => resolve({ outcome: 'launch_failed' }));
    proc.on('close', (code, signal) => {
      if (signal === 'SIGKILL') {
        resolve({ outcome: 'timeout' });
      } else if (code === 0) {
        const version = String(stdout || stderr).split(/\r?\n/)[0].trim();
        resolve({ outcome: 'ok', version });
      } else {
        resolve({ outcome: 'errored', code });
      }
    });
  });
}

async function checkBinary({ id, label, bin, args, hintApt, hintBrew }) {
  const result = await runVersion(bin, args);
  const toolHint = `Debian/Ubuntu: ${hintApt}  •  macOS: ${hintBrew}`;
  const invocation = `${bin} ${args.join(' ')}`;
  switch (result.outcome) {
    case 'ok':
      return { id, label, level: 'ok', detail: result.version || bin };
    case 'timeout':
      return {
        id,
        label,
        level: 'fail',
        detail: `Timed out after ${PROBE_TIMEOUT_MS / 1000}s running '${invocation}' — the binary may be hanging`,
        hint: toolHint
      };
    case 'errored':
      return {
        id,
        label,
        level: 'fail',
        detail: `Present but '${invocation}' failed (exit ${result.code})`,
        hint: toolHint
      };
    default: // 'launch_failed'
      return {
        id,
        label,
        level: 'fail',
        detail: `Not found or not runnable (looked for: ${bin})`,
        hint: toolHint
      };
  }
}

// beets is the one tool we invoke as a versioned subcommand; a present-but-broken
// Python env is common enough to warrant its own warn rather than a hard fail.
async function checkBeets() {
  const result = await runVersion(config.beetBin, ['version']);
  const envHint = 'Check your beets install / Python environment.';
  switch (result.outcome) {
    case 'ok':
      return { id: 'beet', label: 'beets', level: 'ok', detail: result.version || config.beetBin };
    case 'timeout':
      return {
        id: 'beet',
        label: 'beets',
        level: 'fail',
        detail: `Timed out running '${config.beetBin} version' — the binary may be hanging`,
        hint: envHint
      };
    case 'errored':
      return {
        id: 'beet',
        label: 'beets',
        level: 'warn',
        detail: `Found at ${config.beetBin} but 'beet version' failed (exit ${result.code})`,
        hint: envHint
      };
    default: // 'launch_failed' — could not spawn it at all
      return {
        id: 'beet',
        label: 'beets',
        level: 'fail',
        detail: `Not found (looked for: ${config.beetBin})`,
        hint: 'Install in a venv, then set BEET_BIN in .env: python3 -m venv ~/.venvs/beets && ~/.venvs/beets/bin/pip install beets'
      };
  }
}

// RAW_DIR is owned by this app: create it if absent, then confirm it is writable.
// A present-but-unwritable dir is a hard fail — uploads would 500 on every try.
async function checkRawDir() {
  try {
    await fsp.mkdir(config.rawDir, { recursive: true });
    await fsp.access(config.rawDir, fsConstants.W_OK);
    return { id: 'rawDir', label: 'RAW_DIR', level: 'ok', detail: `${config.rawDir} (writable)` };
  } catch (error) {
    return {
      id: 'rawDir',
      label: 'RAW_DIR',
      level: 'fail',
      detail: `${config.rawDir} — ${error.code === 'EACCES' ? 'not writable' : error.message}`,
      hint: 'Point RAW_DIR at a writable folder this app owns, or fix its permissions.'
    };
  }
}

// LIBRARY_DIR is only reported by /api/health — beets' own `directory:` is the
// real import target. It is the least actionable check, so a plain-missing dir
// is NOT worth tripping the banner: beets creates it on the first import. Keep it
// ok in that case and reserve a warn for a genuinely odd state (unreadable, or a
// non-directory sitting at that path).
async function checkLibraryDir() {
  try {
    const stat = await fsp.stat(config.libraryDir);
    if (!stat.isDirectory()) {
      throw new Error('exists but is not a directory');
    }
    return { id: 'libraryDir', label: 'LIBRARY_DIR', level: 'ok', detail: config.libraryDir };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        id: 'libraryDir',
        label: 'LIBRARY_DIR',
        level: 'ok',
        detail: `${config.libraryDir} — not created yet (beets makes it on first import)`
      };
    }
    // A permission error or the "not a directory" throw above is a real problem,
    // so surface its message rather than staying silent.
    return {
      id: 'libraryDir',
      label: 'LIBRARY_DIR',
      level: 'warn',
      detail: `${config.libraryDir} — ${error.message}`,
      hint: "Reported only; the real target is beets' `directory:`. Keep beets config, LIBRARY_DIR, and Navidrome's music folder in sync."
    };
  }
}

// Where the config came from. A missing .env normally means built-in defaults —
// worth a warn on bare metal. But Docker (and any env-first deploy) configures
// everything through process env and ships no .env at all — the image even
// excludes it — so a present-but-not-a-file check would nag every correct Docker
// user forever. Treat the key vars being set in the environment as "configured"
// and stay quiet.
async function checkEnvFile() {
  const configuredViaEnv = Boolean(process.env.RAW_DIR && process.env.BEET_BIN);
  try {
    await fsp.access(path.join(process.cwd(), '.env'), fsConstants.R_OK);
    return { id: 'env', label: 'config', level: 'ok', detail: '.env present' };
  } catch {
    if (configuredViaEnv) {
      return { id: 'env', label: 'config', level: 'ok', detail: 'configured via environment' };
    }
    return {
      id: 'env',
      label: 'config',
      level: 'warn',
      detail: 'no .env and key vars unset — using built-in defaults',
      hint: 'cp .env.example .env (then set RAW_DIR / LIBRARY_DIR / BEET_BIN), or set them in the environment.'
    };
  }
}

export async function runPreflight() {
  const checks = await Promise.all([
    checkEnvFile(),
    checkBinary({
      id: 'ffmpeg',
      label: 'ffmpeg',
      bin: config.ffmpegBin,
      args: ['-version'],
      hintApt: 'sudo apt install ffmpeg',
      hintBrew: 'brew install ffmpeg'
    }),
    checkBinary({
      id: 'ffprobe',
      label: 'ffprobe',
      bin: config.ffprobeBin,
      args: ['-version'],
      hintApt: 'sudo apt install ffmpeg (bundled)',
      hintBrew: 'brew install ffmpeg (bundled)'
    }),
    checkBinary({
      id: 'exiftool',
      label: 'exiftool',
      bin: config.exiftoolBin,
      args: ['-ver'],
      hintApt: 'sudo apt install libimage-exiftool-perl',
      hintBrew: 'brew install exiftool'
    }),
    checkBeets(),
    checkRawDir(),
    checkLibraryDir()
  ]);

  return {
    ok: checks.every((check) => check.level !== 'fail'),
    hasWarnings: checks.some((check) => check.level === 'warn'),
    checks
  };
}
