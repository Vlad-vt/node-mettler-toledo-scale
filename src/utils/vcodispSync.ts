import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { log } from './logger';
import { VCODISP_XML_PATH } from '../config';

/**
 * VCODisp's trigger_stable setting is the SOURCE OF TRUTH for whether FreshAI
 * (the AI weighing flow) is active. This module keeps our own freshai_config.json
 * in sync with it:
 *
 *   - line MISSING in vcodisp.xml  → we ADD it with state="on",
 *                                    set our freshai_enabled=true, log it,
 *                                    and restart VCODisp so the new pipe appears.
 *   - state="on"                   → set our freshai_enabled=true.
 *   - state="off"                  → set our freshai_enabled=false.
 *
 * This prevents the "silent failure" where our UI toggle shows AI as ON while
 * VCODisp never emits Record 70 (because trigger_stable was off) — the toggle
 * now always mirrors reality.
 *
 * Nothing here throws; every path is logged.
 */

// Default attributes for a freshly-inserted line — matches VCODisp's own sample.
const DEFAULT_TRIGGER_LINE =
    '<trigger_stable minWeightChangeGram="20" state="on" minWeight="20" minWeightChangePercent="5"/>';

export interface TriggerSyncResult {
    /** true only if we successfully INSERTED a missing line → VCODisp restart needed. */
    added: boolean;
    /** what freshai_enabled ended up being (our side). */
    desiredEnabled: boolean;
    /** whether freshai_config.json was actually changed. */
    changed: boolean;
}

/**
 * Read vcodisp.xml, decide the desired FreshAI state, and write it into
 * freshai_config.json. Fully synchronous (except the optional VCODisp restart,
 * which the caller kicks off separately based on `added`).
 */
export function syncTriggerStableFromVcodisp(appDirectory: string): TriggerSyncResult {
    const result: TriggerSyncResult = { added: false, desiredEnabled: false, changed: false };

    let xml: string;
    try {
        xml = fs.readFileSync(VCODISP_XML_PATH, 'utf8');
    } catch (e) {
        // Can't read VCODisp's config — don't guess. Keep whatever freshai_config
        // already has so we don't flip the operator's setting on a transient error.
        log(`[VCODISP] Cannot read vcodisp.xml at ${VCODISP_XML_PATH}: ${(e as any).message}. Leaving freshai_config unchanged.`);
        result.desiredEnabled = readFreshaiEnabled(appDirectory);
        return result;
    }

    const match = xml.match(/<trigger_stable\b[^>]*>/i);

    if (!match) {
        // MISSING → add it, turned ON.
        log('[VCODISP] trigger_stable line is MISSING in vcodisp.xml → adding it with state="on"');
        const updated = insertTriggerLine(xml);
        try {
            fs.writeFileSync(VCODISP_XML_PATH, updated, 'utf8');
            log('[VCODISP] trigger_stable ADDED to vcodisp.xml (state="on"). VCODisp restart required to apply.');
            result.added = true;
            result.desiredEnabled = true;
        } catch (e) {
            const code = (e as any).code || '';
            log(`[VCODISP ERROR] Failed to write vcodisp.xml (${code} ${(e as any).message}). ` +
                `This usually needs administrator rights on Program Files. ` +
                `Please add the following line manually and restart VCODisp: ${DEFAULT_TRIGGER_LINE}`);
            // Write failed — don't claim AI is on when the pipe won't exist.
            result.desiredEnabled = false;
        }
    } else {
        // EXISTS → read its state and adapt our side. We do NOT modify the file.
        const line = match[0];
        const stateMatch = line.match(/\bstate\s*=\s*"([^"]*)"/i);
        const state = stateMatch ? stateMatch[1].trim().toLowerCase() : '';
        if (state === 'on') {
            log('[VCODISP] trigger_stable found: state="on" → enabling FreshAI on our side');
            result.desiredEnabled = true;
        } else if (state === 'off') {
            log('[VCODISP] trigger_stable found: state="off" → disabling FreshAI on our side');
            result.desiredEnabled = false;
        } else {
            log(`[VCODISP] trigger_stable found but state="${state || '(absent)'}" is unrecognised → treating as OFF`);
            result.desiredEnabled = false;
        }
    }

    result.changed = writeFreshaiEnabled(appDirectory, result.desiredEnabled);
    return result;
}

function readFreshaiEnabled(appDirectory: string): boolean {
    try {
        const p = path.join(appDirectory, 'freshai_config.json');
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        return cfg.freshai_enabled === true;
    } catch {
        return false;
    }
}

/** Set freshai_enabled non-destructively (keeps delay_* keys). Returns whether it changed. */
function writeFreshaiEnabled(appDirectory: string, enabled: boolean): boolean {
    const p = path.join(appDirectory, 'freshai_config.json');
    try {
        let cfg: any = {};
        try {
            cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            cfg = {};
        }
        if (cfg.freshai_enabled === enabled) {
            log(`[VCODISP] freshai_config already matches vcodisp.xml (freshai_enabled=${enabled}) — no change`);
            return false;
        }
        cfg.freshai_enabled = enabled;
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
        log(`[VCODISP] freshai_config.json updated: freshai_enabled=${enabled} (synced from vcodisp.xml)`);
        return true;
    } catch (e) {
        log(`[VCODISP ERROR] Failed to update freshai_config.json: ${(e as any).message}`);
        return false;
    }
}

/** Insert DEFAULT_TRIGGER_LINE right before </MT_VCODisp>, preserving indentation. */
function insertTriggerLine(xml: string): string {
    const indent = '    ';
    if (/<\/MT_VCODisp>/.test(xml)) {
        // Insert before the closing tag, keeping whatever indentation it has.
        return xml.replace(/([ \t]*)<\/MT_VCODisp>/, `${indent}${DEFAULT_TRIGGER_LINE}\n$1</MT_VCODisp>`);
    }
    // Fallback: no closing tag found — append at the end.
    return xml.replace(/\s*$/, '') + `\n${indent}${DEFAULT_TRIGGER_LINE}\n`;
}

/**
 * Restart VCODisp by running its own stop/run scripts (found in the sibling
 * ../bin folder next to etc/vcodisp.xml). Called only after we ADD a missing
 * trigger_stable line, so VCODisp re-reads the config and creates the pipe.
 * Never throws.
 */
export async function restartVcodisp(): Promise<void> {
    const binDir = path.resolve(path.dirname(VCODISP_XML_PATH), '..', 'bin');
    const stopBat = 'stopvcodisp.bat';
    const runBat = 'runvcodisp.bat';

    if (!fs.existsSync(path.join(binDir, stopBat)) || !fs.existsSync(path.join(binDir, runBat))) {
        log(`[VCODISP] Restart scripts not found in ${binDir}. ` +
            `VCODisp must be restarted manually (or on next reboot) to apply trigger_stable.`);
        return;
    }

    log('[VCODISP] Auto-restarting VCODisp to apply new trigger_stable...');

    const stopCode = await runBatch(stopBat, binDir);
    // TASKKILL returns non-zero when vcodisp.exe wasn't running — that's fine.
    log(`[VCODISP] stopvcodisp.bat finished (exit ${stopCode})`);

    await sleep(2000);

    const runCode = await runBatch(runBat, binDir);
    log(`[VCODISP] runvcodisp.bat finished (exit ${runCode}) — VCODisp starting`);
}

/** Run a .bat by filename with cwd=binDir. Resolves with the exit code; never rejects. */
function runBatch(batFile: string, cwd: string): Promise<number> {
    return new Promise((resolve) => {
        try {
            const child = spawn('cmd.exe', ['/c', batFile], { cwd, windowsHide: true });
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('error', (err) => {
                log(`[VCODISP] ${batFile} spawn error: ${err.message}`);
                resolve(-1);
            });
            child.on('close', (code) => {
                if (stderr.trim()) log(`[VCODISP] ${batFile} stderr: ${stderr.trim()}`);
                resolve(code === null ? -1 : code);
            });
        } catch (e) {
            log(`[VCODISP] ${batFile} failed to launch: ${(e as any).message}`);
            resolve(-1);
        }
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}
