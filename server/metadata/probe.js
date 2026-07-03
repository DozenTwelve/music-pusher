import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { AUDIO_EXTENSIONS } from '../upload.js';

// Prefix for the temp file written during an in-place tag rewrite. A crashed
// rewrite can leave one behind; it must never be mistaken for a real track.
export const TEMP_PREFIX = '__fix__';

export function runProcess(bin, args) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Album folders are usually flat, but cover-art subfolders and disc subfolders
// happen, so walk the whole tree and keep only audio files.
export async function listAudioFiles(albumPath) {
  const found = [];
  const stack = [albumPath];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      // Skip leftover rewrite temp files so a crashed fix never gets counted
      // as a track (or, worse, imported into the library).
      if (entry.name.startsWith(TEMP_PREFIX)) {
        continue;
      }
      if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(fullPath);
      }
    }
  }

  found.sort((a, b) => a.localeCompare(b));
  return found;
}

export async function probeTags(absPath) {
  // One ffprobe call yields both the format tags and the stream dispositions, so
  // embedded cover art (a video stream flagged attached_pic) is detected without
  // spawning a second process per track.
  const { code, stdout } = await runProcess(config.ffprobeBin, [
    '-v',
    'error',
    '-show_entries',
    'format=format_name:format_tags:stream=codec_type:stream_disposition=attached_pic',
    '-of',
    'json',
    absPath
  ]);

  const tags = {};
  if (code === 0) {
    try {
      const parsed = JSON.parse(stdout);
      const rawTags = parsed?.format?.tags || {};
      // Tag keys vary in case across muxers; fold to lowercase.
      for (const [key, value] of Object.entries(rawTags)) {
        tags[key.toLowerCase()] = value;
      }
      tags.__format_name = parsed?.format?.format_name || '';
      const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
      tags.__has_art = streams.some(
        (stream) => stream?.codec_type === 'video' && stream?.disposition?.attached_pic === 1
      );
    } catch {
      // leave tags empty on parse failure
    }
  }
  return tags;
}

// "1/8" or "1" -> { num: 1, total: 8|null }
export function parseNumberPair(value) {
  if (value == null) {
    return { num: null, total: null };
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
  if (!match) {
    return { num: null, total: null };
  }
  return {
    num: Number.parseInt(match[1], 10),
    total: match[2] ? Number.parseInt(match[2], 10) : null
  };
}

export function leadingTrackNumber(fileName) {
  const match = path.basename(fileName).match(/^\s*(\d{1,3})\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}
