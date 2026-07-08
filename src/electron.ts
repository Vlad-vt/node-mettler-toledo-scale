import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as config from './config';
import { PORT, PORT_HTTPS } from './config';
import { app as expressApp } from './server';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { scaleCommunicationService } from './services/ScaleCommunicationService';
import { verifyCRC } from './utils/CRCVerification';
import { log } from './utils/logger';
const { version } = require('../package.json');

export let mainWindow: BrowserWindow | null;

// Global crash handlers — catch silent failures so they end up in the log
process.on('uncaughtException', (err) => {
    try { log(`[CRASH] uncaughtException: ${err && err.stack ? err.stack : err}`); } catch (_) {}
});
process.on('unhandledRejection', (reason: any) => {
    try { log(`[CRASH] unhandledRejection: ${reason && reason.stack ? reason.stack : JSON.stringify(reason)}`); } catch (_) {}
});

// Heartbeat every 60 seconds — proves the app is alive when no traffic is happening
setInterval(() => {
    try {
        const mem = process.memoryUsage();
        log(`[HEARTBEAT] alive, uptime=${Math.round(process.uptime())}s rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
    } catch (_) {}
}, 60000);

/**
 * Ensure every config file exists with sane defaults. Runs at startup in the
 * main process so by the time the UI loads, all files are guaranteed present.
 */
function ensureConfigs() {
    const appDirectory = path.dirname(process.execPath);
    log('[CONFIG] Ensuring configs in:', appDirectory);

    const defaults: Record<string, any> = {
        'currency_config.json': { currency_type: 'Euro' },
        'wiegebon_config.json': { druk_type: 'Ja' },
        'freshai_config.json': { freshai_enabled: true, delay_after_off_ms: 250, delay_before_on_ms: 0 },
        'api_config.json': { api_url_type: 'Test' },
    };

    for (const [name, def] of Object.entries(defaults)) {
        const full = path.join(appDirectory, name);
        try {
            if (fs.existsSync(full)) {
                // Validate JSON — if corrupt, rewrite with defaults
                try {
                    const raw = fs.readFileSync(full, 'utf8');
                    const parsed = JSON.parse(raw);
                    // Merge missing keys from defaults (non-destructive)
                    let mutated = false;
                    for (const k of Object.keys(def)) {
                        if (parsed[k] === undefined) {
                            parsed[k] = def[k];
                            mutated = true;
                        }
                    }
                    if (mutated) {
                        fs.writeFileSync(full, JSON.stringify(parsed, null, 2), 'utf8');
                        log(`[CONFIG] ${name}: filled missing keys`);
                    } else {
                        log(`[CONFIG] ${name}: OK (${JSON.stringify(parsed)})`);
                    }
                } catch (parseErr) {
                    log(`[CONFIG] ${name}: corrupt JSON, rewriting with defaults (${(parseErr as any).message})`);
                    fs.writeFileSync(full, JSON.stringify(def, null, 2), 'utf8');
                }
            } else {
                fs.writeFileSync(full, JSON.stringify(def, null, 2), 'utf8');
                log(`[CONFIG] ${name}: created with defaults ${JSON.stringify(def)}`);
            }
        } catch (e) {
            log(`[CONFIG ERROR] ${name}: ${(e as any).message} — check write permissions on ${appDirectory}`);
        }
    }
}

function createApplicationWindow() {
    mainWindow = new BrowserWindow({
        width: 400,
        height: 400,
        frame: false,
        focusable: false,
        title: `Faktura Modul HF ScaIF v${version}`,
        webPreferences: {
            nodeIntegration: true,
        },
    });
    mainWindow!.setPosition(10, 150);
    mainWindow!.setSkipTaskbar(true);

    mainWindow!.loadFile('dist/templates/electron.html');
    mainWindow.webContents.once('did-finish-load', async () => {
        const [checksumOk, crc] = await verifyCRC();
        if (!checksumOk) {
            dialog.showMessageBox(mainWindow!, {
                message: 'Checksum mismatch',
            });
            setTimeout(() => {
                return mainWindow!.close();
            }, 1000);
        } else {
            log('Checksums ok');
            log(config);
            mainWindow!.webContents.send('set-crc', { crc });
            mainWindow!.on('close', (event) => {
                event.preventDefault();
                mainWindow!.hide();
            });
            // expressApp.listen(PORT, () => {
            //     log('API listening on', PORT);
            //     log('version', version);
            // });

            // const httpsOptions = {
            //     key: fs.readFileSync('C:/xampp/apache/conf/ssl.key/server.key'),
            //     cert: fs.readFileSync(
            //         'C:/xampp/apache/conf/ssl.crt/server.crt'
            //     ),
            // };
            const httpsOptions = {
                key: fs.readFileSync('C:/xampp/apache/conf/test/privkey5.pem'),
                cert: fs.readFileSync('C:/xampp/apache/conf/test/cert5.pem'),
            };
            const httpsServer = https
                .createServer(httpsOptions, expressApp)
                .listen(PORT_HTTPS, () => {
                    log('API listening on', PORT_HTTPS);
                    log('version', version);
                });
            const httpServer = http
                .createServer(expressApp)
                .listen(PORT, () => {
                    log('API listening on', PORT);
                    log('version', version);
                });

            // Retry the pipe connection until VCODisp is ready (it may not be
            // accepting connections yet right after a cash-register reboot).
            scaleCommunicationService.initWithRetry();
            //HERE DO NOT HIDE WINDOWS
            // setTimeout(() => {
            //     return mainWindow!.hide();
            // }, 6000);
        }
    });

    mainWindow!.on('closed', function () {
        mainWindow = null;
        app.quit();
    });

    ipcMain.on('connection-toggle', (_, { isConnected }) => {
        // Use initWithRetry (not init) so a manual connect also keeps retrying;
        // it no-ops if a retry loop is already running. destroy() unsubscribes
        // the drop-watchers so an explicit disconnect won't auto-reconnect.
        isConnected
            ? scaleCommunicationService.initWithRetry()
            : scaleCommunicationService.destroy();
    });

    ipcMain.on('reset-empty-r05-test', async () => {
        log('[reset тары] IPC received — sending empty Record 05');
        try {
            const ok = await scaleCommunicationService.sendEmptyRecord05();
            log(`[reset тары] Empty Record 05 result: ${ok ? 'ACK' : 'no-ACK'}`);
        } catch (e) {
            log(`[reset тары] FAILED: ${JSON.stringify(e) || (e as any).message || e}`);
        }
    });

    ipcMain.on('trigger-stable-toggle', async (_, { enabled }) => {
        // IMPORTANT: only start/stop the trigger listener here. We must NOT do a
        // hard reconnect of VCOIn/VCOOut on startup — those are already being
        // connected by init() in did-finish-load. Doing a second disconnect+
        // reconnect created a race: the first (still-connecting) sockets became
        // orphaned and fired ETIMEDOUT ~30s later, dropping the connection a
        // couple of minutes after boot. setTriggerStableEnabled only touches the
        // dedicated trigger pipe and leaves VCOIn/VCOOut alone.
        log(`[IPC] trigger-stable-toggle → ${enabled ? 'ON' : 'OFF'}`);
        try {
            scaleCommunicationService.setTriggerStableEnabled(enabled);
            log(`Trigger stable listener: ${enabled ? 'ON' : 'OFF'}`);
        } catch (e) {
            log('[IPC] trigger-stable-toggle failed:', (e as any).message || e);
        }
    });

}

function createLoadingScreen() {
    mainWindow = new BrowserWindow({
        width: 600,
        height: 550,
        title: `Faktura Modul HF ScaIF v${version}`,
        frame: false,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
        },
    });
    mainWindow!.loadFile('dist/templates/loadingScreen.html');
    mainWindow!.on('closed', function () {
        mainWindow = null;
        app.quit();
    });
}

app.whenReady().then((_) => {
    ensureConfigs();
    const hasSquirrelEvents = process.argv.some((arg) =>
        arg.includes('--squirrel')
    );
    // if no events => dev environment or regular run
    if (!hasSquirrelEvents) {
        createApplicationWindow();
        // else production env
    } else {
        const squirrelEvent = process.argv[1];
        switch (squirrelEvent) {
            case '--squirrel-install':
                return createLoadingScreen();
            case '--squirrel-firstrun':
                return createApplicationWindow();
            default:
                // not sure if this will be required
                return createApplicationWindow();
        }
    }
});
