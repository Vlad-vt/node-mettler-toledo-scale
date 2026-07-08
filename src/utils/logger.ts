import { mainWindow } from '../electron';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(path.dirname(process.execPath), 'logs');
const GENERAL_LOG = path.join(LOG_DIR, 'app.log');
const FRESHAI_LOG = path.join(LOG_DIR, 'freshai.log');
const TRIGGER_LOG = path.join(LOG_DIR, 'trigger_stable.log');

// Create logs directory on startup
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

// --- Weekly log cleanup ---------------------------------------------------
// Once every 7 days, empty all log files so they never accumulate forever.
// The last-clean time is stored in a marker file, so the schedule survives
// app restarts (we don't clean on every launch, only when a week has passed).
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CLEAN_MARKER = path.join(LOG_DIR, '.last_clean');
const ALL_LOGS = [GENERAL_LOG, FRESHAI_LOG, TRIGGER_LOG];

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
      // First run — just set the marker, don't wipe fresh logs
      writeLastClean(now);
      return;
    }
    if (now - last < WEEK_MS) return;

    // A week has passed — truncate every log file
    for (const f of ALL_LOGS) {
      try { fs.writeFileSync(f, ''); } catch (_) {}
      try { fs.unlinkSync(f + '.1'); } catch (_) {}  // drop rotation backup too
    }
    writeLastClean(now);
    try {
      fs.appendFileSync(GENERAL_LOG, `[${timestamp()}] [LOG] weekly cleanup done — logs cleared\n`);
    } catch (_) {}
  } catch (_) {}
}

// Check on startup, then once a day while running
maybeWeeklyClean();
setInterval(maybeWeeklyClean, 24 * 60 * 60 * 1000);

// Rotate log files larger than 20 MB to .1 (single backup), then delete .1 next time
const MAX_LOG_SIZE = 20 * 1024 * 1024;

function maybeRotate(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_LOG_SIZE) return;
    const backup = filePath + '.1';
    try { fs.unlinkSync(backup); } catch (_) {}
    try { fs.renameSync(filePath, backup); } catch (_) {}
  } catch (_) {
    // file might not exist yet — that's fine
  }
}

let appendCounter = 0;
function appendToFile(filePath: string, message: string) {
  try {
    // Check rotation every 100 writes (cheap; full statSync each time would be slow)
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

export const logFreshAI = (...args: any[]) => {
  const msg = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  log('[FreshAI]', ...args);
  appendToFile(FRESHAI_LOG, msg);
};

export const logTrigger = (...args: any[]) => {
  const msg = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  log('[TriggerStable]', ...args);
  appendToFile(TRIGGER_LOG, msg);
};

// export const log = (...args: any[]) => {
//   console.log(args);
//   try {
//     args.forEach((toLog) => {
//       if (typeof toLog === 'string') {
//         return mainWindow?.webContents.send('log', toLog);
//       }
//       if (Buffer.isBuffer(toLog)) {
//         // @ts-ignore
//         mainWindow?.webContents.send('log', `${toLog.inspect().replace('<', '&lt;').replace('>', '&gt;')}`);
//       } else {
//           mainWindow?.webContents.send('log', JSON.stringify(toLog, null, 2));
//       }
//     });
//   } catch (error) {
//     console.log(args);
//   }
// };
