import { ReceiptContext, WeightSuccessResponse } from '../types';
import { BrowserWindow, app, dialog } from 'electron';
import { log } from '../utils/logger';
import { join } from 'path';
import { promises as fs } from 'fs';
import { mainWindow } from '../electron';
import { stateService } from '../services/StateService';
import { verifyCRC } from './CRCVerification';
import bwipjs from 'bwip-js';
import ejs from 'ejs';

/**
 * main function for printing receiptss
 */
export const printReceipt = async (weight: WeightSuccessResponse, force: boolean = false) => {

    const path = require('path');
    // render template

    // Get the directory path of the executable file
    const appDirectory = path.dirname(process.execPath);

    if (force) {
        log('[PRINT] force=true → bypassing wiegebon check (explicit print command)');
    } else {
        const wiegebonConfigPath = path.join(appDirectory, 'wiegebon_config.json');
        let wiegebonConfig: any;
        try {
            const wiegebonConfigData = await fs.readFile(wiegebonConfigPath, 'utf8');
            wiegebonConfig = JSON.parse(wiegebonConfigData);
            log(`[CONFIG READ] wiegebon_config.json → druk_type=${wiegebonConfig.druk_type}`);
        } catch (e) {
            log(`[CONFIG READ] wiegebon_config.json FAILED → defaulting to druk_type=Ja: ${(e as any).message || e}`);
            wiegebonConfig = { druk_type: 'Ja' };
        }

        if(wiegebonConfig.druk_type === "Nein") {
            log('[PRINT] skipped: wiegebon druk_type=Nein');
            return;
        }
    }


    const {
        description_text,
        should_print_additional_text,
        should_print_barcode,
        ean,
        tare,
    } = stateService.getSettingsState() as any;
    const [checksumOk, crc] = await verifyCRC();
    const date = new Date();


        // Construct the path to the currency configuration JSON file
        const currencyConfigPath = path.join(appDirectory, 'currency_config.json');

        // Read the currency configuration JSON file
        let currencyConfig: any;
        try {
            const currencyConfigData = await fs.readFile(currencyConfigPath, 'utf8');
            currencyConfig = JSON.parse(currencyConfigData);
            log(`[CONFIG READ] currency_config.json → currency_type=${currencyConfig.currency_type}`);
        } catch (e) {
            log(`[CONFIG READ] currency_config.json FAILED → defaulting to currency_type=Euro: ${(e as any).message || e}`);
            currencyConfig = { currency_type: 'Euro' };
        }

        let templatePath: string;

        let dateStr: string = '';

        // Determine the template path based on the currency type
        switch (currencyConfig.currency_type) {
            case 'Euro':
                templatePath = join(app.getAppPath(), 'dist/templates/receiptEuro.ejs');
                dateStr =
                addZ(date.getDate()) +
                '.' +
                addZ(date.getMonth() + 1) +
                '.' +
                date.getFullYear() +
                '; ' +
                date.getHours() +
                '.' +
                addZ(date.getMinutes()) +
                ' Uhr';
                break;
            case 'Crown':
                templatePath = join(app.getAppPath(), 'dist/templates/receiptCrown.ejs');
                dateStr =
                addZ(date.getDate()) +
                '.' +
                addZ(date.getMonth() + 1) +
                '.' +
                date.getFullYear() +
                '; ' +
                date.getHours() +
                '.' +
                addZ(date.getMinutes()) +
                ' Hodin';
                break;
            case 'Franc':
                templatePath = join(app.getAppPath(), 'dist/templates/receiptFranc.ejs');
                dateStr =
                addZ(date.getDate()) +
                '.' +
                addZ(date.getMonth() + 1) +
                '.' +
                date.getFullYear() +
                '; ' +
                date.getHours() +
                '.' +
                addZ(date.getMinutes()) +
                ' Uhr';
                break;
            case 'BulgrarianLev':
                templatePath = join(app.getAppPath(), 'dist/templates/receiptBulgarianLev.ejs');
                dateStr =
                addZ(date.getDate()) +
                '.' +
                addZ(date.getMonth() + 1) +
                '.' +
                date.getFullYear() +
                '; ' +
                date.getHours() +
                '.' +
                addZ(date.getMinutes()) +
                ' ч.';
                break;
            case 'PolishZloty':
                templatePath = join(app.getAppPath(), 'dist/templates/receiptPolishZloty.ejs');
                dateStr =
                addZ(date.getDate()) +
                '.' +
                addZ(date.getMonth() + 1) +
                '.' +
                date.getFullYear() +
                '; ' +
                date.getHours() +
                '.' +
                addZ(date.getMinutes()) +
                '';
                break;
            case 'SerbianDinar':
                    templatePath = join(app.getAppPath(), 'dist/templates/receiptSerbianDinar.ejs');
                    dateStr =
                    addZ(date.getDate()) +
                    '.' +
                    addZ(date.getMonth() + 1) +
                    '.' +
                    date.getFullYear() +
                    '; ' +
                    date.getHours() +
                    '.' +
                    addZ(date.getMinutes()) +
                    ' часова';
                    break;
            case 'SwissFranc':
                templatePath = join(app.getAppPath(), 'dist/templates/receiptSwissFranc.ejs');
                dateStr =
                addZ(date.getDate()) +
                '.' +
                addZ(date.getMonth() + 1) +
                '.' +
                date.getFullYear() +
                '; ' +
                date.getHours() +
                '.' +
                addZ(date.getMinutes()) +
                ' Uhr';
                break;
            default:
                templatePath = join(app.getAppPath(), 'dist/templates/receiptFranc.ejs');
                break;
        }

    // Normalize tare to a numeric value — stateService may have it as string ("0.004") or number
    const tareNum = typeof tare === 'number' ? tare : (typeof tare === 'string' ? parseFloat(tare.replace(',', '.')) : 0);

    const context: ReceiptContext = {
        ...weight,
        description_text,
        should_print_barcode,
        should_print_additional_text,
        date: dateStr,
        crc: crc.toUpperCase(),
        tare: Number.isFinite(tareNum) ? tareNum : 0,
        ean,
    };

    if (should_print_barcode) {
        const formatted_price = plainFloats({
            n: context.selling_price,
            is_weight: false,
        });
        const formatted_weight = plainFloats({
            n: context.weight,
            is_weight: true,
        });
        const qrtext = `${ean}|${description_text}|${formatted_weight}|${formatted_price}`;
        const barcode = await generateBarcode({ text: qrtext, scale: 1 });
        context.barcode = barcode;
    }

        // Render the template as a real Promise so we can await actual print completion
        log(`[PRINT] using template: ${templatePath}`);
        await new Promise<void>((resolve) => {
            ejs.renderFile(templatePath, context, (err, data) => {
                if (err) {
                    log('[PRINT] ejs.renderFile error:', err);
                    return resolve();
                }
                log(`[PRINT] EJS rendered OK, length=${data.length} chars`);

                const workerWindow: BrowserWindow = new BrowserWindow({
                    show: false,
                });
                workerWindow.loadURL(
                    'data:text/html;charset=utf-8,' + encodeURI(data)
                );

                let resolved = false;
                const finish = () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(safetyTimer);
                    try { workerWindow.close(); } catch (e) {}
                    resolve();
                };

                workerWindow.webContents.on('did-finish-load', () => {
                    log('[PRINT] did-finish-load fired');

                    // IMPORTANT: enumerate printers HERE, after the page finished
                    // loading. On the very first launch after install, calling
                    // getPrinters() too early (right after createWindow) returns an
                    // EMPTY list because Chromium's print subsystem is not warmed up
                    // yet — which made the code fall back to PDF and skip printing.
                    // Querying inside did-finish-load gives the real printer list.
                    const printers = workerWindow.webContents.getPrinters();
                    log(`[PRINT] available printers: ${printers.length}`);
                    printers.forEach((p, i) => {
                        log(`[PRINT]   [${i}] name="${p.name}" isDefault=${p.isDefault} status=${p.status}`);
                    });

                    if (printers.length > 0) {
                        // Explicitly select a printer: the OS default if flagged,
                        // otherwise the first one. Relying on Chromium's implicit
                        // default silently failed on machines where no printer was
                        // flagged isDefault.
                        const target = printers.find((p) => p.isDefault) || printers[0];
                        log(`[PRINT] sending to printer "${target.name}"`);
                        const printOpts: any = { silent: true, deviceName: target.name, margins: { marginType: 'none' } };
                        workerWindow.webContents.print(
                            printOpts,
                            (success: boolean, errMsg: string) => {
                                if (success) log('[PRINT] printed successfully');
                                if (errMsg) log('[PRINT] err while printing:', errMsg);
                                finish();
                            }
                        );
                    } else {
                        // No printers at all. Do NOT open a modal save dialog here —
                        // on an unattended POS it would hang the request forever and
                        // race the safety timer. Just log and resolve.
                        log('[PRINT] no printers found — skipping print (no modal dialog on POS)');
                        finish();
                    }
                });

                // Safety timeout — don't block forever if did-finish-load never fires
                const safetyTimer = setTimeout(() => {
                    if (resolved) return;
                    log('[PRINT] safety timeout 10s — resolving');
                    finish();
                }, 10000);
            });
        });
};

/**
 * sends window to default printer
 */
function sendToPrinter(workerWindow: BrowserWindow) {
    workerWindow.webContents.print(
        { silent: true, margins: { marginType: 'none' } },
        (success, err) => {
            if (success) log('printed successfully');
            if (err) log('err while printing', err);
            workerWindow.close();
        }
    );
}
/**
 * saves window as pdf
 */
async function saveAsPDF(workerWindow: BrowserWindow) {
    const { filePath } = await dialog.showSaveDialog(mainWindow!, {
        filters: [{ name: 'receipt', extensions: ['pdf'] }],
    });
    if (filePath) {
        try {
            const pdfData = await workerWindow.webContents.printToPDF({});
            await fs.writeFile(filePath, pdfData);
            log('pdf file created successfully');
        } catch (error) {
            log('err while saving pdf', error);
        }
    } else {
        log('saving cancelled');
    }
}

function generateBarcode({
    text = '123456789012',
    scale = 1,
}): Promise<string> {
    return new Promise((resolve, reject) => {
        bwipjs.toBuffer(
            {
                bcid: 'qrcode',
                text,
                scale,
                // height,
                // includetext: true,
                textxalign: 'center',
            },
            (err, buffer) => {
                if (err) {
                    reject(err);
                    log(err);
                } else {
                    resolve(
                        'data:image/png;base64,' + buffer.toString('base64')
                    );
                }
            }
        );
    });
}

function addZ(n: number) {
    return n < 10 ? '0' + n : '' + n;
}

function plainFloats({ n, is_weight }: { n: number; is_weight: boolean }) {
    let whole = Math.floor(n);
    let fraction = 0;
    let test = '';
    if (is_weight) {
        fraction = Math.round((n - whole) * 1000);
        test = `${whole.toString()}${fraction.toString().padEnd(3, '0')}`;
    } else {
        fraction = Math.round((n - whole) * 100);
        test = `${whole.toString()}${fraction.toString().padEnd(2, '0')}`;
    }

    return test;
}
