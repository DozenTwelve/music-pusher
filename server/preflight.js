import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { runProcess } from './metadata/probe.js';

// Runtime counterpart to scripts/doctor.sh: the same host checks, but served to
// the UI so the homepage can warn when a required tool or path is missing.
//
// Levels:
//   fail — a hard requirement is missing; the app cannot do its job.
//   warn — degraded or unverified; the app may still work.
//   ok   — verified good. The UI hides the banner only when EVERY check is ok.

// Run a binary's version command. A path with a separator must be executable;
// a bare name must resolve on PATH. spawn surfaces both as an error (code -1),
// so a zero exit is the single signal that the tool is present and runnable.
async function checkBinary({ id, label, bin, args, hintApt, hintBrew }) {
  const { code, stdout, stderr } = await runProcess(bin, args);
  if (code === 0) {
    const version = String(stdout || stderr).split(/\r?\n/)[0].trim();
    return { id, label, level: 'ok', detail: version || bin };
  }
  return {
    id,
    label,
    level: 'fail',
    detail: `Not found or not runnable (looked for: ${bin})`,
    hint: `Debian/Ubuntu: ${hintApt}  •  macOS: ${hintBrew}`
  };
}

// beets is the one tool we invoke as a versioned subcommand; a present-but-broken
// Python env is common enough to warrant its own warn rather than a hard fail.
async function checkBeets() {
  const { code, stdout } = await runProcess(config.beetBin, ['version']);
  if (code === 0) {
    const version = String(stdout).split(/\r?\n/)[0].trim();
    return { id: 'beet', label: 'beets', level: 'ok', detail: version || config.beetBin };
  }
  // code -1 means spawn could not launch it at all (missing); any other non-zero
  // means it launched but errored — usually a busted venv.
  if (code === -1) {
    return {
      id: 'beet',
      label: 'beets',
      level: 'fail',
      detail: `Not found (looked for: ${config.beetBin})`,
      hint: 'Install in a venv, then set BEET_BIN in .env: python3 -m venv ~/.venvs/beets && ~/.venvs/beets/bin/pip install beets'
    };
  }
  return {
    id: 'beet',
    label: 'beets',
    level: 'warn',
    detail: `Found at ${config.beetBin} but 'beet version' failed`,
    hint: 'Check your beets install / Python environment.'
  };
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
// real import target. So a missing one is a warn, not a fail: it usually means
// nothing has been imported yet, or the three-way path sync is off.
async function checkLibraryDir() {
  try {
    const stat = await fsp.stat(config.libraryDir);
    if (!stat.isDirectory()) {
      throw new Error('exists but is not a directory');
    }
    return { id: 'libraryDir', label: 'LIBRARY_DIR', level: 'ok', detail: config.libraryDir };
  } catch {
    return {
      id: 'libraryDir',
      label: 'LIBRARY_DIR',
      level: 'warn',
      detail: `${config.libraryDir} does not exist yet`,
      hint: "Reported only; the real target is beets' `directory:`. Keep beets config, LIBRARY_DIR, and Navidrome's music folder in sync."
    };
  }
}

// A missing .env means every path/binary is a built-in default — fine for a
// first look, but almost never what a real install wants, so surface it as warn.
async function checkEnvFile() {
  try {
    await fsp.access(path.join(process.cwd(), '.env'), fsConstants.R_OK);
    return { id: 'env', label: '.env', level: 'ok', detail: 'present' };
  } catch {
    return {
      id: 'env',
      label: '.env',
      level: 'warn',
      detail: 'not found — using built-in defaults',
      hint: 'cp .env.example .env, then set RAW_DIR / LIBRARY_DIR / BEET_BIN.'
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
