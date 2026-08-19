import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as config from './config';
import { PORT, PORT_HTTPS } from './config';
import { app as expressApp } from './server';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { scaleCommunicationService } from './services/ScaleCommunicationService';
import { verifyCRC } from './utils/CRCVerification';
import { log } from './utils/logger';
const { version } = require('../package.json');

export let mainWindow: BrowserWindow | null;

// [DIAG] Global crash handlers — catch silent failures so they end up in the log
process.on('uncaughtException', (err) => {
    try { log(`[CRASH] uncaughtException: ${err && err.stack ? err.stack : err}`); } catch (_) {}
});
process.on('unhandledRejection', (reason: any) => {
    try { log(`[CRASH] unhandledRejection: ${reason && reason.stack ? reason.stack : JSON.stringify(reason)}`); } catch (_) {}
});

// [DIAG] Heartbeat every 60 seconds — proves the process is alive and the event
// loop is not frozen even when no traffic is happening.
setInterval(() => {
    try {
        const mem = process.memoryUsage();
        log(`[HEARTBEAT] alive, uptime=${Math.round(process.uptime())}s rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB sockets=${openSockets}`);
    } catch (_) {}
}, 60000);

// [DIAG] Live count of open TCP sockets on our HTTP/HTTPS servers.
let openSockets = 0;

/**
 * [DIAG] Attach connection-level observability to an HTTP/HTTPS server.
 * Pure observation: we only ADD listeners for 'connection' and per-socket
 * events. We deliberately do NOT listen for 'clientError' or 'timeout' on the
 * server, because attaching those would OVERRIDE Node's default handling and
 * change behaviour — this build must behave exactly like the 2024-05-17 one.
 */
function instrumentServer(server: any, label: string) {
    server.on('connection', (socket: any) => {
        openSockets++;
        const id = `${socket.remoteAddress}:${socket.remotePort}`;
        const openedAt = Date.now();
        log(`[CONN] ${label} OPEN ${id} (open sockets=${openSockets})`);

        socket.on('close', (hadError: boolean) => {
            openSockets--;
            log(`[CONN] ${label} CLOSE ${id} hadError=${hadError} lifetime=${Date.now() - openedAt}ms (open sockets=${openSockets})`);
        });
        socket.on('error', (err: any) => {
            log(`[CONN] ${label} ERROR ${id}: ${err && err.message ? err.message : err}`);
        });
        socket.on('timeout', () => {
            log(`[CONN] ${label} TIMEOUT ${id} after ${Date.now() - openedAt}ms`);
        });
    });

    // Log the effective Node timeout settings once, so the log states exactly
    // which defaults this build ran with.
    log(`[CONN] ${label} timeouts: keepAliveTimeout=${server.keepAliveTimeout}ms headersTimeout=${server.headersTimeout}ms timeout=${server.timeout}ms`);
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

            instrumentServer(httpsServer, 'HTTPS:' + PORT_HTTPS);
            instrumentServer(httpServer, 'HTTP:' + PORT);
            log(`[DIAG] node=${process.versions.node} electron=${process.versions.electron} chrome=${process.versions.chrome}`);

            scaleCommunicationService.init();
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
        isConnected
            ? scaleCommunicationService.init()
            : scaleCommunicationService.destroy();
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
