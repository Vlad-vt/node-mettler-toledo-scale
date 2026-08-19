import { mainWindow } from '../electron';
import fs from 'fs';
import path from 'path';

/**
 * File logging added to the original 2024-05-17 build for diagnostics.
 * The ORIGINAL logger only wrote to console + the app window, so nothing
 * survived a restart. Behaviour of the app itself is unchanged — this file
 * only adds persistence, rotation and weekly cleanup.
 */

const LOG_DIR = path.join(path.dirname(process.execPath), 'logs');
const GENERAL_LOG = path.join(LOG_DIR, 'app.log');

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

// --- Weekly log cleanup ---------------------------------------------------
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CLEAN_MARKER = path.join(LOG_DIR, '.last_clean');
const ALL_LOGS = [GENERAL_LOG];

function readLastClean(): number {
  try {
    const raw = fs.readFileSync(CLEAN_MARKER, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (_) {
    return 0;
  }
}

function writeLastClean(ts: number) {
  try { fs.writeFileSync(CLEAN_MARKER, String(ts), 'utf8'); } catch (_) {}
}

function maybeWeeklyClean() {
  try {
    const now = Date.now();
    const last = readLastClean();
    if (last === 0) {
      writeLastClean(now);
      return;
    }
    if (now - last < WEEK_MS) return;
    for (const f of ALL_LOGS) {
      try { fs.writeFileSync(f, ''); } catch (_) {}
      try { fs.unlinkSync(f + '.1'); } catch (_) {}
    }
    writeLastClean(now);
    try {
      fs.appendFileSync(GENERAL_LOG, `[${timestamp()}] [LOG] weekly cleanup done — logs cleared\n`);
    } catch (_) {}
  } catch (_) {}
}

maybeWeeklyClean();
setInterval(maybeWeeklyClean, 24 * 60 * 60 * 1000);

// Rotate log files larger than 20 MB to .1 (single backup)
const MAX_LOG_SIZE = 20 * 1024 * 1024;

function maybeRotate(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_SIZE) return;
    const backup = filePath + '.1';
    try { fs.unlinkSync(backup); } catch (_) {}
    try { fs.renameSync(filePath, backup); } catch (_) {}
  } catch (_) {}
}

let appendCounter = 0;
function appendToFile(filePath: string, message: string) {
  try {
    if (++appendCounter % 100 === 0) maybeRotate(filePath);
    fs.appendFileSync(filePath, `[${timestamp()}] ${message}\n`);
  } catch (_) {}
}

export const log = (...args: any[]) => {
  console.log(args);
  try {
    const msg = args.map((toLog) => {
      if (typeof toLog === 'string') {
        return toLog
      }
      if (Buffer.isBuffer(toLog)) {
        // @ts-ignore
        return `${toLog.inspect().replace('<', '&lt;').replace('>', '&gt;')}`;
      } else {
          return JSON.stringify(toLog, null, 2);
      }
    }).join(' ');
    mainWindow?.webContents.send('log', msg);
    appendToFile(GENERAL_LOG, msg);
  } catch (error) {
    console.log(args);
  }
};
