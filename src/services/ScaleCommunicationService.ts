import { forkJoin, merge, of, Subscription } from 'rxjs';
import { catchError, first, tap, timeout } from 'rxjs/operators';
import { BufferTranslator } from '../classes/BufferTranslator';
import { Pipe } from '../classes/Pipe';
import { ScaleTranslator } from '../classes/ScaleTranslator';
import { IN_PIPE_PATH, OUT_PIPE_PATH, TRIGGER_STABLE_PIPE_PATH } from '../config';
import { mainWindow } from '../electron';
import { ConnectResponse, Settings, ValidatedSettings, WeightSuccessResponseWithReceiptInfo } from '../types';
import { _b } from '../utils/bytesConvertion';
import { log, logFreshAI, logTrigger } from '../utils/logger';
import { printReceipt } from '../utils/printer';
import { stateService } from './StateService';
import { freshAIService } from './FreshAIService';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { FreshAIRecognitionResponse } from '../types';

// handles
class ScaleCommunicationService {
  input_pipe!: Pipe;
  output_pipe!: Pipe;

  private isRequestPending = false;
  private latestTriggerResult: WeightSuccessResponseWithReceiptInfo | null = null;
  private triggerStableSub: Subscription | null = null;
  private triggerStablePipe: Pipe | null = null;
  private displayKeepAliveTimer: NodeJS.Timeout | null = null;
  private displayKeepAliveStartedAt: number = 0;
  // Settings to re-send periodically via Record 05 to keep VCODisp window open
  private displayKeepAliveSettings: any = null;
  // Gate for trigger_stable AI flow — true when ready for next item, false while processing
  private aiReadyToScan: boolean = true;
  // Serialize trigger_stable subscription callbacks (Record 70/71) so they
  // process strictly in order — no two records race against each other.
  private triggerHandlerQueue: Promise<void> = Promise.resolve();
  // Guards against two init() calls racing (initWithRetry loop vs connection-toggle IPC)
  private isConnecting = false;
  // Subscriptions on the main pipes' connection state — used to self-heal on drop
  private inputConnSub: Subscription | null = null;
  private outputConnSub: Subscription | null = null;
  // True while a retry loop is already running, so we don't start a second one
  private retryLoopActive = false;

  // Serialize all scale requests through a promise chain.
  // Two simultaneous requestScale() calls would subscribe to the same
  // output_pipe.data$ stream and tangle their responses — never let two run at once.
  private requestQueue: Promise<any> = Promise.resolve();

  constructor() {}

  /**
   * claims scale pipes
   * highest level connect function
   */
  init(): Promise<ConnectResponse> {
    if (this.isConnected) {
      return Promise.resolve({ input: true, output: true });
    }
    // Guard against a second init() racing the first (initWithRetry loop vs the
    // connection-toggle IPC). Without this, both would allocate new Pipe objects
    // over each other and orphan the earlier sockets/timers.
    if (this.isConnecting) {
      log('[INIT] init() already in progress — ignoring concurrent call');
      return Promise.resolve({ input: false, output: false });
    }
    this.isConnecting = true;

    // Tear down any previous (half-open / orphaned) pipes before allocating new
    // ones, so we never leak a live socket + its 5s connect timer.
    this.teardownMainPipes();

    this.input_pipe = new Pipe(IN_PIPE_PATH);
    this.input_pipe.connect();
    if (IN_PIPE_PATH !== OUT_PIPE_PATH) {
      this.output_pipe = new Pipe(OUT_PIPE_PATH);
      this.output_pipe.connect();
    } else {
      this.output_pipe = this.input_pipe;
    }

    return forkJoin({
      input: merge(this.input_pipe.errors$, this.input_pipe.is_connected$).pipe(first((v) => !!v)),
      output: merge(this.output_pipe.errors$, this.output_pipe.is_connected$).pipe(first((v) => !!v)),
    })
      .pipe(
        first((v) => !!v),
        tap(({ input, output }) => {
          this.isConnecting = false;
          const hasErrors = input instanceof Error || output instanceof Error;
          const connected = Boolean(input && output && !hasErrors);
          mainWindow?.webContents.send('connection-changed', { isConnected: connected });
          if (hasErrors) {
            log('errors while connecting to pipes', input, output);
          }
          if (connected) {
            this.watchMainPipesForDrop();
          }
        }),
      )
      .toPromise()
      .catch((e) => {
        this.isConnecting = false;
        log('[INIT] init() promise error: ' + ((e as any).message || e));
        return { input: false, output: false } as ConnectResponse;
      });
  }

  /** Remove connection-drop watchers and destroy the current main pipes. */
  private teardownMainPipes() {
    if (this.inputConnSub) { this.inputConnSub.unsubscribe(); this.inputConnSub = null; }
    if (this.outputConnSub) { this.outputConnSub.unsubscribe(); this.outputConnSub = null; }
    try { if (this.input_pipe) this.input_pipe.disconnect(); } catch (e) {}
    try { if (this.output_pipe && this.output_pipe !== this.input_pipe) this.output_pipe.disconnect(); } catch (e) {}
  }

  /**
   * Watch the connected main pipes; if either drops (VCODisp restarts mid-
   * session), re-arm the retry loop so the app self-heals without a manual
   * restart. Without this, a mid-session drop left every request timing out.
   */
  private watchMainPipesForDrop() {
    if (this.inputConnSub) { this.inputConnSub.unsubscribe(); this.inputConnSub = null; }
    if (this.outputConnSub) { this.outputConnSub.unsubscribe(); this.outputConnSub = null; }

    const onDrop = (which: string) => {
      log(`[INIT] main pipe dropped (${which}) — re-arming connect retry`);
      this.emitConnectionState();
      // Fire-and-forget; initWithRetry no-ops if a loop is already running.
      this.initWithRetry();
    };

    // skip the current 'true' value, react only to a later 'false'
    this.inputConnSub = this.input_pipe.is_connected$.subscribe((c) => {
      if (c === false) onDrop('VCOIn');
    });
    if (this.output_pipe !== this.input_pipe) {
      this.outputConnSub = this.output_pipe.is_connected$.subscribe((c) => {
        if (c === false) onDrop('VCOOut');
      });
    }
  }

  /**
   * Connect to the scale pipes, retrying FOREVER until VCODisp is ready.
   * After a Windows/cash-register reboot, VCODisp may not be accepting pipe
   * connections yet when we start. We keep retrying with a fixed delay so the
   * app self-heals without any manual restart, no matter how long VCODisp
   * takes to come up.
   */
  async initWithRetry(delayMs: number = 3000): Promise<void> {
    // Only one retry loop at a time. The self-heal drop-watcher also calls this,
    // so without the guard a mid-session drop could spawn multiple loops.
    if (this.retryLoopActive) {
      log('[INIT] retry loop already active — not starting another');
      return;
    }
    this.retryLoopActive = true;

    let attempt = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt++;
        try {
          log(`[INIT] pipe connect attempt ${attempt}`);
          const res = await this.init();
          const inputOk = res && res.input === true;
          const outputOk = res && res.output === true;
          if (inputOk && outputOk) {
            log('[INIT] pipes connected successfully');
            return;
          }
          log(`[INIT] attempt ${attempt} did not connect both pipes (input=${JSON.stringify(res && res.input)}, output=${JSON.stringify(res && res.output)})`);
        } catch (e) {
          log(`[INIT] attempt ${attempt} error: ${(e as any).message || e}`);
        }

        // Tear down any half-open sockets before retrying so we start clean
        this.teardownMainPipes();

        log(`[INIT] VCODisp not ready — retrying in ${delayMs}ms... (attempt ${attempt})`);
        await this.sleep(delayMs);
      }
    } finally {
      this.retryLoopActive = false;
    }
  }

  /**
   * disconnects from pipes
   * highest level disconnect func
   */
  destroy() {
    if (this.triggerStableSub) {
      this.triggerStableSub.unsubscribe();
      this.triggerStableSub = null;
    }
    if (this.triggerStablePipe) {
      this.triggerStablePipe.disconnect();
      this.triggerStablePipe = null;
    }
    // teardownMainPipes unsubscribes the drop-watchers first, so this disconnect
    // does NOT re-trigger the self-heal retry loop.
    this.teardownMainPipes();
    mainWindow?.webContents.send('connection-changed', { isConnected: false });
  }

  /**
   * getter for connection state (both pipes).
   * PURE read — no side effects. Previously this sent a 'connection-changed'
   * IPC on every access, which flooded the renderer (the getter is read twice
   * per HTTP request and once per retry-loop cycle). The UI is notified about
   * state changes explicitly from init()/destroy()/the pipe subscriptions.
   */
  get isConnected() {
    const initialized = Boolean(this.input_pipe && this.output_pipe);
    return initialized && this.input_pipe.is_connected$.getValue() && this.output_pipe.is_connected$.getValue();
  }

  /** Notify the renderer of the current connection state (call on transitions). */
  private emitConnectionState() {
    mainWindow?.webContents.send('connection-changed', { isConnected: this.isConnected });
  }

  /**
   * send a request to scale and awaits for the response.
   * All requests are serialized through requestQueue so two concurrent
   * subscriptions on output_pipe.data$ can never tangle their responses.
   */
  private performRawRequest(buffer: Buffer): Promise<Buffer> {
    const run = () => new Promise<Buffer>((resolve) => {
      const reqHex = buffer.toString('hex');
      const reqAscii = Array.from(buffer).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
      log(`[SCALE] >>> REQ hex=${reqHex} ascii="${reqAscii}" len=${buffer.length} pending=${this.isRequestPending}`);

      const startedAt = Date.now();
      this.isRequestPending = true;
      const dataSub = this.output_pipe.data$
        .pipe(
          timeout(1000),
          catchError((_) => {
            log(`[SCALE] !!! TIMEOUT after 1000ms (req hex=${reqHex})`);
            return of(Buffer.from([_b.NAK]));
          }),
        )
        .subscribe((response) => {
          const elapsed = Date.now() - startedAt;
          const resHex = response.toString('hex');
          const resAscii = Array.from(response).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
          log(`[SCALE] <<< RES hex=${resHex} ascii="${resAscii}" len=${response.length} elapsed=${elapsed}ms`);
          dataSub.unsubscribe();
          this.isRequestPending = false;
          resolve(response);
        });

      try {
        const writeOk = this.input_pipe.socket.write(buffer);
        log(`[SCALE]     socket.write returned: ${writeOk}`);
      } catch (e) {
        log(`[SCALE] !!! socket.write threw: ${(e as any).message || e}`);
      }
    });

    // Chain after any in-flight request so we never have two subscriptions live at once
    const queued = this.requestQueue.then(run, run);
    this.requestQueue = queued.catch(() => {});  // swallow errors in chain so it doesn't lock up
    return queued;
  }

  /**
   * send a request to scale and awaits for the response
   * async, returns promise
   * @param buffer - data to be sent
   */
  private async requestScale(request: Buffer): Promise<Buffer> {
    const scaleResp = await this.performRawRequest(request);
    // handle checksum
    if (BufferTranslator.isChecksumRequired(scaleResp)) {
      const [left, right] = BufferTranslator.parseChecksumRotations(scaleResp);
      const checksum = Buffer.concat([BufferTranslator.rotateLeft(left), BufferTranslator.rotateRight(right)]);
      const prefix = Buffer.from([_b.EOT, _b.STX, _b.D1, _b.D0, _b.ESC]);
      const suffix = Buffer.from([_b.ETX]);
      await this.performRawRequest(Buffer.concat([prefix, checksum, suffix]));
      const response = await this.performRawRequest(Buffer.from([_b.EOT, _b.ENQ]));
      const isChecksumValid = response.slice(4, 5).equals(Buffer.from([0x31]));
      if (!isChecksumValid) {
        log('checksum requested => ', scaleResp);
        log('checksum send => ', checksum);
        throw new Error('checksum incorrect');
      } else {
        log('checksum ok');
        return this.performRawRequest(request);
      }
      // if ok send initial, return resp
    } else {
      return scaleResp;
    }
  }

  /**
   * Public lightweight wrapper around the raw EOT ENQ request.
   * Used to nudge VCODisp into refreshing its display window after Record 05
   * (without triggering printReceipt or FreshAI flows that getWeight() does).
   * Returns the raw Buffer (Record 02) — caller can ignore.
   */
  async getWeightRaw(): Promise<Buffer> {
    return this.requestCurrentWeight();
  }

  /**
   * Send Record 71: "Request weight price AND TARE" — Dialog 6 v2.00.
   * Scale answers with Record 72 which contains scale_status + weight +
   * unit_price + selling_price + TARE (last field).
   * Used to refresh VCODisp display so tara is visible (Record 02 doesn't
   * carry tara, so without this VCODisp may not render the tara field).
   */
  async requestWeightWithTare(): Promise<Buffer> {
    const { EOT, STX, D7, D1, ETX } = _b;
    const buf = Buffer.from([EOT, STX, D7, D1, ETX]);  // EOT STX "71" ETX
    return this.requestScale(buf);
  }

  /**
   * Send a bare EOT — "Standardizing of scale: the scale interface is set to
   * its basic state" (Dialog 6). This maps to OPOS "Reset Scale Interface"
   * (DirectIO 3002). It clears the preset tare AND the article data.
   *
   * Per the VCODisp Trigger Documentation, Record 70 is only pushed when
   * "no article data available (no PLU entered at the POS)". So clearing the
   * article data via EOT should RE-ARM the trigger feature — letting Record 70
   * fire again after a classic weighing.
   *
   * Fire-and-forget: a bare EOT has no expected response.
   */
  sendEOTReset(): void {
    try {
      this.input_pipe.socket.write(Buffer.from([_b.EOT]));
      log('[EOT RESET] Sent bare EOT (standardize scale → clears tare + article data, re-arms triggers)');
    } catch (e) {
      log('[EOT RESET] Failed to send EOT: ' + ((e as any).message || e));
    }
  }

  /**
   * Keep VCODisp's Waagenfenster open by periodically re-sending Record 05
   * with the SAME article info. Each Record 05 ACK refreshes VCODisp's
   * weighingMS timer, so the window stays open until we stop pinging.
   * Sending Record 71 (request weight+tara) is NOT enough — VCODisp doesn't
   * treat read requests as "weighing activity" and lets the window close.
   *
   * Stopped on Record 71 (item removed) or after max duration.
   */
  startDisplayKeepAlive(settings: any, intervalMs: number = 1000, maxDurationMs: number = 5 * 60 * 1000) {
    this.stopDisplayKeepAlive();
    this.displayKeepAliveStartedAt = Date.now();
    this.displayKeepAliveSettings = settings;
    log(`[KEEPALIVE] starting Record 05 keepalive interval=${intervalMs}ms max=${maxDurationMs}ms (article="${settings.description_text}", tare=${settings.tare}, unit_price=${settings.unit_price})`);

    this.displayKeepAliveTimer = setInterval(async () => {
      if (!this.displayKeepAliveSettings) {
        this.stopDisplayKeepAlive();
        return;
      }
      // Safety cap — don't ping forever
      if (Date.now() - this.displayKeepAliveStartedAt > maxDurationMs) {
        log('[KEEPALIVE] max duration reached, stopping');
        this.stopDisplayKeepAlive();
        return;
      }
      try {
        // Re-send Record 05 — refreshes VCODisp's weighingMS timer
        await this.setSettings(this.displayKeepAliveSettings);
        // No success log per tick — would flood the log file
      } catch (e) {
        // Silent fail per tick — scale may be temporarily busy
      }
    }, intervalMs);
  }

  // Cache the last keepalive settings AFTER stopDisplayKeepAlive nulls them out,
  // so the Record 71 handler can re-use the article info for the clear-tare Record 05.
  private lastKeepAliveSettings: any = null;

  stopDisplayKeepAlive() {
    if (this.displayKeepAliveTimer) {
      this.lastKeepAliveSettings = this.displayKeepAliveSettings;
      clearInterval(this.displayKeepAliveTimer);
      this.displayKeepAliveTimer = null;
      this.displayKeepAliveSettings = null;
      log('[KEEPALIVE] stopped');
    }
  }

  getLastKeepAliveSettings(): any | null {
    return this.lastKeepAliveSettings;
  }

  /**
   * send a request for current weight without any handles
   */
  private async requestCurrentWeight(): Promise<Buffer> {
    const { EOT, ENQ } = _b;
    const buf = Buffer.from([EOT, ENQ]);
    return this.requestScale(buf);
  }

  /**
   * when nak is received we need to ask scale what's wrong,
   * so this function does this
   */
  private async requestNakExplanation(): Promise<Buffer> {
    const { EOT, STX, D0, D8, ETX } = _b;
    const buf = Buffer.from([EOT, STX, D0, D8, ETX]);
    return this.requestScale(buf);
  }

  /**
   * get current weight with nak handle, with retry on transient NAK 01
   * returns valid, human-readable response
   */
  async getWeight(): Promise<WeightSuccessResponseWithReceiptInfo> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 400;
    let weight: Buffer | null = null;
    let lastNakReason: any = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log(`[getWeight] Attempt ${attempt}/${MAX_RETRIES} — sending EOT ENQ to scale`);
      const resp = await this.requestCurrentWeight();
      log(`[getWeight] Attempt ${attempt} raw response: ${resp.toString('hex')}`);

      if (!BufferTranslator.isNak(resp)) {
        weight = resp;
        log(`[getWeight] Attempt ${attempt} OK — got valid weight buffer`);
        break;
      }

      const why = await this.requestNakExplanation();
      lastNakReason = BufferTranslator.parseNakReason(why);
      log(`[getWeight] Attempt ${attempt} NAK: ${JSON.stringify(lastNakReason)} (raw=${why.toString('hex')})`);

      if (attempt < MAX_RETRIES) {
        log(`[getWeight] Waiting ${RETRY_DELAY_MS}ms before retry...`);
        await this.sleep(RETRY_DELAY_MS);
      }
    }

    if (!weight) {
      log(`[getWeight] All ${MAX_RETRIES} attempts failed, NAK: ${JSON.stringify(lastNakReason)}`);

      // On error 30 ("scale in MIN range" — operator started a weighing with no
      // item on the scale) auto-apply the tare reset (empty Record 05). This
      // clears the pending article data so trigger_stable (Record 70) can fire
      // again for the next item — without this the AI stays silent until reset.
      if (lastNakReason && lastNakReason.error_code === '30') {
        log('[getWeight] Error 30 detected → auto-applying tare reset (empty Record 05)');
        try {
          await this.sendEmptyRecord05();
          log('[getWeight] Tare reset (empty Record 05) applied after error 30');
        } catch (e) {
          log(`[getWeight] Tare reset after error 30 failed: ${JSON.stringify(e) || (e as any).message || e}`);
        }
      }

      throw lastNakReason;
    }

    {
      const parsedWeight = BufferTranslator.parseValidWeight(weight);

      // NOTE: getWeight is the DEFAULT flow — POS calls it AFTER the AI
      // recognition already happened in the trigger_stable handler (Record 70).
      // So we do NOT run FreshAI again here. This is the classic behaviour:
      // get weight from scale → print receipt. The VCODisp window appears
      // naturally via the Record 05 that POS sent in the preceding setSettings.
      let errors;
      try {
        await printReceipt(parsedWeight);
      } catch (error) {
        log('printing failed:', error);
        errors = error;
      }
      return { ...parsedWeight, receipt_printed: !Boolean(errors), receipt_print_errors: errors, recognition: null };
    }
  }

  private isFreshAIEnabled(): boolean {
    try {
      const appDirectory = path.dirname(process.execPath);
      const configPath = path.join(appDirectory, 'freshai_config.json');
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      const enabled = config.freshai_enabled === true;
      log(`[CONFIG READ] freshai_config.json → freshai_enabled=${enabled}`);
      return enabled;
    } catch (e) {
      log(`[CONFIG READ] freshai_config.json FAILED → defaulting to false: ${(e as any).message || e}`);
      return false;
    }
  }

  /**
   * Reads configured delays (milliseconds) from freshai_config.json.
   * delay_after_off_ms: pause after scanner-off before FreshAI
   * delay_before_on_ms: pause after FreshAI before scanner-on
   */
  private getFreshAIDelays(): { delayAfterOff: number; delayBeforeOn: number } {
    try {
      const appDirectory = path.dirname(process.execPath);
      const configPath = path.join(appDirectory, 'freshai_config.json');
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      const delayAfterOff = Number(config.delay_after_off_ms) || 0;
      const delayBeforeOn = Number(config.delay_before_on_ms) || 0;
      log(`[CONFIG READ] delays → after_off=${delayAfterOff}ms, before_on=${delayBeforeOn}ms`);
      return { delayAfterOff, delayBeforeOn };
    } catch (e) {
      log(`[CONFIG READ] delays FAILED → defaulting to 0: ${(e as any).message || e}`);
      return { delayAfterOff: 0, delayBeforeOn: 0 };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static POS_API_URLS = {
    Test: 'https://offline.kassesvn.tn-rechenzentrum1.de/mettler.php',
    Release: 'https://offline.tn-kasse.de/mettler.php',
  };

  /**
   * Reads api_config.json and returns POS API URL based on Test/Release type.
   * Defaults to Test if config missing or invalid.
   */
  private getPosApiUrl(): string {
    try {
      const appDirectory = path.dirname(process.execPath);
      const configPath = path.join(appDirectory, 'api_config.json');
      const data = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(data);
      const type = config.api_url_type === 'Release' ? 'Release' : 'Test';
      const url = ScaleCommunicationService.POS_API_URLS[type];
      log(`[CONFIG READ] api_config.json → api_url_type=${type}, url=${url}`);
      return url;
    } catch (e) {
      log(`[CONFIG READ] api_config.json FAILED → defaulting to Test: ${(e as any).message || e}`);
      return ScaleCommunicationService.POS_API_URLS.Test;
    }
  }

  /**
   * CRC32 matching PHP's crc32() — returns signed 32-bit integer
   */
  private crc32(str: string): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i);
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    crc ^= 0xFFFFFFFF;
    // PHP crc32() returns signed 32-bit
    if (crc > 0x7FFFFFFF) {
      crc -= 0x100000000;
    }
    return crc;
  }

  /**
   * Send a command to the local scanner/data API at http://localhost:47125/data
   * Used for scanner-off, scanner-on, and data forwarding.
   */
  private sendLocalCommand(command: string): Promise<void> {
    return new Promise((resolve) => {
      const body = JSON.stringify({ message: command });
      const options = {
        hostname: 'localhost',
        port: 47125,
        path: '/data',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      log(`[LOCAL API] POST http://localhost:47125/data → ${body}`);
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          log(`[LOCAL API] Response: ${res.statusCode} ${data}`);
          resolve();
        });
      });
      req.on('error', (err) => {
        log(`[LOCAL API] Error: ${err.message}`);
        resolve();
      });
      req.setTimeout(3000, () => {
        log('[LOCAL API] Timeout (3s)');
        req.destroy();
        resolve();
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Send weight + FreshAI recognition data to local API (http://localhost:47125/data).
   * Priority target — sent before POS API.
   */
  private sendToLocal(weight: number, recognition: FreshAIRecognitionResponse): Promise<void> {
    const payload = {
      type: 'mettler_fresh_ai_detected_set',
      data: {
        weight,
        json_mettler: {
          code: recognition.code,
          msg: recognition.msg,
          sessionid: recognition.sessionid,
          // Send raw PLU from FreshAI (no CRC32 transformation)
          value: recognition.value.map(item => ({
            plu: item.plu,
            confidence: item.confidence,
          })),
        },
      },
    };

    return new Promise((resolve) => {
      const body = JSON.stringify(payload);
      const options = {
        hostname: 'localhost',
        port: 47125,
        path: '/data',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      logTrigger('=== LOCAL API DATA REQUEST ===');
      logTrigger('URL: http://localhost:47125/data');
      logTrigger('Method: POST');
      logTrigger('Content-Type: application/json');
      logTrigger('Body: ' + body);
      logTrigger('=============================');

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          logTrigger('=== LOCAL API DATA RESPONSE ===');
          logTrigger('Status: ' + res.statusCode);
          logTrigger('Body: ' + data);
          logTrigger('===============================');
          resolve();
        });
      });
      req.on('error', (err) => {
        logTrigger('=== LOCAL API DATA ERROR ===');
        logTrigger('Error: ' + err.message);
        logTrigger('============================');
        resolve();
      });
      req.setTimeout(5000, () => {
        logTrigger('[LOCAL API DATA] Timeout (5s)');
        req.destroy();
        resolve();
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Sends weight + FreshAI recognition to POS API
   * POST https://offline.kasse.inc/mettler.php
   */
  private sendToPOS(weight: number, recognition: FreshAIRecognitionResponse): void {
    const postData = new URLSearchParams();
    postData.append('type', 'mettler_fresh_ai_detected_set');
    postData.append('data', JSON.stringify({
      weight,
      json_mettler: {
        code: recognition.code,
        msg: recognition.msg,
        sessionid: recognition.sessionid,
        value: recognition.value.map(item => ({
          plu: item.plu,
          confidence: item.confidence,
        })),
      },
    }));

    const body = postData.toString();
    const apiUrl = this.getPosApiUrl();
    const url = new URL(apiUrl);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    };

    const jsonPayload = JSON.stringify({
      weight,
      json_mettler: {
        code: recognition.code,
        msg: recognition.msg,
        sessionid: recognition.sessionid,
        value: recognition.value.map(item => ({
          plu: item.plu,
          confidence: item.confidence,
        })),
      },
    }, null, 2);

    logTrigger('=== POS API REQUEST ===');
    logTrigger('URL: ' + apiUrl);
    logTrigger('Method: POST');
    logTrigger('Content-Type: application/x-www-form-urlencoded');
    logTrigger('type: mettler_fresh_ai_detected_set');
    logTrigger('data: ' + jsonPayload);
    logTrigger('======================');

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk: any) => responseData += chunk);
      res.on('end', () => {
        logTrigger('=== POS API RESPONSE ===');
        logTrigger('Status: ' + res.statusCode);
        logTrigger('Body: ' + responseData);
        logTrigger('========================');
      });
    });

    req.on('error', (err) => {
      logTrigger('=== POS API ERROR ===');
      logTrigger('Error: ' + err.message);
      logTrigger('=====================');
    });

    req.write(body);
    req.end();
  }

  /**
   * Checks if buffer is a Record 70 from trigger_stable pipe.
   * VCODisp writes Record 70 to \\.\pipe\VCOTriggerStableWeight when weight stabilizes.
   * Format: <STX>70<ESC>weight<ESC>unit_price<ETX>
   */
  private isTriggerStableRecord(buf: Buffer): boolean {
    return buf.length > 3 && buf[0] === _b.STX && buf[1] === _b.D7 && buf[2] === _b.D0;
  }

  /**
   * Parses Record 70 weight data from trigger_stable pipe.
   * Format: <STX>70<ESC>weight<ESC>unit_price<ETX>
   * Example: <STX>70<ESC>00116<ESC>00000<ETX> => weight=0.116kg, unit_price=0
   */
  private parseTriggerStableWeight(buf: Buffer): WeightSuccessResponseWithReceiptInfo {
    const chunks = BufferTranslator.parse(buf);
    // Per VCODisp Trigger Documentation (record 70): STX 70 ESC <net weight 5>
    // ESC <tare weight 5> ETX. So chunks = ["70", net_weight, tare].
    // Field 2 is TARE (not unit_price). Guard against short/fragmented frames.
    const b_weight = chunks[1];
    const b_tare = chunks[2];

    const weightStr = b_weight ? b_weight.toString('utf8') : '';
    const tareStr = b_tare ? b_tare.toString('utf8') : '';

    const weight = weightStr ? ScaleTranslator.translateStringToFloat(weightStr, 3) : 0;
    const tare = tareStr ? ScaleTranslator.translateStringToFloat(tareStr, 3) : 0;

    return {
      scale_status: 'trigger_stable',
      weight: Number.isFinite(weight) ? weight : 0,
      unit_price: 0,   // Record 70 does not carry a unit price
      selling_price: 0,
      tare: Number.isFinite(tare) ? tare : 0,
      receipt_printed: false,
      receipt_print_errors: null,
      recognition: null,
    };
  }

  /**
   * Checks if buffer is a Record 71 (trigger reset — item removed from scale).
   * Format: <STX>71<ETX>
   */
  private isTriggerResetRecord(buf: Buffer): boolean {
    return buf.length >= 3 && buf[0] === _b.STX && buf[1] === _b.D7 && buf[2] === _b.D1;
  }

  /**
   * Connects to the dedicated VCOTriggerStableWeight pipe and listens for Record 70/71 pushes.
   * Record 70: weight stabilized (contains weight + unit_price)
   * Record 71: item removed from scale (reset)
   */
  private startTriggerStableListener() {
    if (this.triggerStableSub) {
      this.triggerStableSub.unsubscribe();
    }
    if (this.triggerStablePipe) {
      this.triggerStablePipe.disconnect();
    }

    this.triggerStablePipe = new Pipe(TRIGGER_STABLE_PIPE_PATH);
    this.triggerStablePipe.connect();

    this.triggerStablePipe.is_connected$.subscribe((connected) => {
      if (connected) {
        logTrigger('Trigger stable pipe connected: ' + TRIGGER_STABLE_PIPE_PATH);
      }
    });

    this.triggerStablePipe.errors$.subscribe((err) => {
      logTrigger('Trigger stable pipe error: ' + err.message);
    });

    this.triggerStableSub = this.triggerStablePipe.data$.subscribe((data: Buffer) => {
      // Chain into the trigger handler queue so Record 70 and Record 71 are
      // processed STRICTLY IN ORDER. The .catch is CRITICAL: without it, a single
      // rejected handler would turn triggerHandlerQueue into a permanently-
      // rejected promise, and every subsequent .then() would skip its callback —
      // silently dropping all future Record 70/71 events until app restart.
      this.triggerHandlerQueue = this.triggerHandlerQueue
        .then(() => this.handleTriggerStableData(data))
        .catch((e) => { logTrigger('Trigger handler error (chain kept alive): ' + ((e as any).message || e)); });
    });
  }

  /** Handle a single Record 70/71 event from the trigger_stable pipe. */
  private async handleTriggerStableData(data: Buffer) {
      // Record 71 = item removed. We do NOT touch the scale here — no Record 05,
      // no EOT. Just reset our internal state so the next item can be scanned.
      if (this.isTriggerResetRecord(data)) {
        logTrigger('Trigger stable: Record 71 (reset) — item removed from scale');
        this.latestTriggerResult = null;
        mainWindow?.webContents.send('trigger-stable-reset');

        // Open gate for next item — ready to scan again
        this.aiReadyToScan = true;
        logTrigger('AI gate: readyToScan=true (ready for next item)');
        return;
      }

      // Only process Record 70
      if (!this.isTriggerStableRecord(data)) {
        logTrigger('Trigger stable: unknown record, raw=' + data.toString('hex'));
        return;
      }

      // Gate: only process Record 70 when previous AI flow is fully done
      if (!this.aiReadyToScan) {
        logTrigger('Trigger stable: Record 70 ignored — AI gate is busy (previous item still in flight)');
        return;
      }
      this.aiReadyToScan = false;
      logTrigger('AI gate: readyToScan=false (processing new item)');

      logTrigger('Trigger stable: Record 70 received, raw=' + data.toString('hex'));

      try {
        const parsed = this.parseTriggerStableWeight(data);

        if (this.isFreshAIEnabled()) {
          const { delayAfterOff, delayBeforeOn } = this.getFreshAIDelays();

          // Scanner OFF via local API
          await this.sendLocalCommand('scanner-off');
          logTrigger('Scanner OFF command sent');

          // Delay after scanner-off, before FreshAI recognition
          if (delayAfterOff > 0) {
            logTrigger(`Sleeping ${delayAfterOff}ms after scanner-off...`);
            await this.sleep(delayAfterOff);
          }

          try {
            parsed.recognition = await freshAIService.recognize();
          } catch (e) {
            logFreshAI('FreshAI recognition failed:', e);
          }

          // Delay after FreshAI, before scanner-on
          if (delayBeforeOn > 0) {
            logTrigger(`Sleeping ${delayBeforeOn}ms before scanner-on...`);
            await this.sleep(delayBeforeOn);
          }

          // Scanner ON via local API
          await this.sendLocalCommand('scanner-on');
          logTrigger('Scanner ON command sent');
        }

        this.latestTriggerResult = parsed;

        // Send to both APIs if recognition available
        if (parsed.recognition && parsed.recognition.value && parsed.recognition.value.length > 0) {
          // 1. Priority: local API (localhost:47125)
          await this.sendToLocal(parsed.weight, parsed.recognition);
          // 2. Offline POS API (Test/Release)
          this.sendToPOS(parsed.weight, parsed.recognition);
        }

        // Notify Electron UI
        mainWindow?.webContents.send('trigger-stable', this.latestTriggerResult);
        log('Trigger stable result stored:', JSON.stringify(this.latestTriggerResult));
      } catch (e) {
        logTrigger('Trigger stable: error processing Record 70:', e);
      } finally {
        // CRITICAL: ALWAYS reopen the AI gate after processing completes.
        // Don't rely on Record 71 alone — VCODisp may not push it consistently
        // after multiple keepalive Record 05 sends. Without this, AI works only
        // once per startup.
        this.aiReadyToScan = true;
        logTrigger('AI gate: readyToScan=true (Record 70 handler finished — ready for next)');
      }
  }

  /**
   * Returns the latest trigger_stable result (weight + recognition)
   */
  getLatestTriggerResult(): WeightSuccessResponseWithReceiptInfo | null {
    return this.latestTriggerResult;
  }

  /**
   * Reset scale: try multiple reset sequences in order, see which one clears
   * the error state. Returns ASCII summary of attempts.
   */
  async resetScale(): Promise<string> {
    const summary: string[] = [];
    log('[RESET] === Scale reset sequence start ===');

    const tryStep = async (label: string, action: () => Promise<any>) => {
      try {
        log(`[RESET] Step: ${label}`);
        const result = await action();
        const note = `${label}: ${typeof result === 'string' ? result : 'OK'}`;
        log(`[RESET]   → ${note}`);
        summary.push(note);
        await this.sleep(300);
      } catch (e) {
        const note = `${label}: FAIL ${(e as any).message || e}`;
        log(`[RESET]   → ${note}`);
        summary.push(note);
      }
    };

    // 1. Single EOT (Dialog6 abort)
    await tryStep('EOT alone', async () => {
      const buf = Buffer.from([_b.EOT]);
      this.input_pipe.socket.write(buf);
      return 'sent';
    });

    // 2. Triple EOT (flush buffers)
    await tryStep('EOT x3', async () => {
      this.input_pipe.socket.write(Buffer.from([_b.EOT, _b.EOT, _b.EOT]));
      return 'sent';
    });

    // 3. Try to query weight — if NAK still 01, scale still locked
    await tryStep('Probe getWeight after EOT', async () => {
      const resp = await this.requestCurrentWeight();
      if (BufferTranslator.isNak(resp)) return 'still NAK';
      return 'OK weight=' + resp.toString('hex');
    });

    // 4. Send fake Record 71 (item removed) to VCOIn — pretend unload
    await tryStep('Fake Record 71 (item removed)', async () => {
      // STX "71" ETX
      const buf = Buffer.from([_b.EOT, _b.STX, 0x37, 0x31, _b.ETX]);
      this.input_pipe.socket.write(buf);
      return 'sent';
    });

    // 5. Probe again
    await tryStep('Probe getWeight after Record 71', async () => {
      const resp = await this.requestCurrentWeight();
      if (BufferTranslator.isNak(resp)) return 'still NAK';
      return 'OK weight=' + resp.toString('hex');
    });

    // 6. Hard pipe reconnect
    await tryStep('Hard pipe reconnect', async () => {
      await this.reconnectAll(this.triggerStableSub !== null);
      return 'done';
    });

    // 7. Final probe
    await tryStep('Final probe getWeight', async () => {
      const resp = await this.requestCurrentWeight();
      if (BufferTranslator.isNak(resp)) return 'still NAK';
      return 'OK weight=' + resp.toString('hex');
    });

    log('[RESET] === Scale reset sequence done ===');
    return summary.join(' | ');
  }

  /**
   * Hard reconnect: disconnect all three pipes (VCOIn, VCOOut, TriggerStable),
   * wait briefly, then reconnect. Use as a clean slate when toggling modes.
   */
  async reconnectAll(reopenTrigger: boolean): Promise<void> {
    log('[RECONNECT] === Hard reconnect start ===');

    // 1. Stop trigger stable listener
    if (this.triggerStableSub) {
      this.triggerStableSub.unsubscribe();
      this.triggerStableSub = null;
      log('[RECONNECT] trigger stable subscription cleared');
    }
    if (this.triggerStablePipe) {
      try { this.triggerStablePipe.disconnect(); } catch (e) { log('[RECONNECT] trigger pipe disconnect error: ' + (e as any).message); }
      this.triggerStablePipe = null;
      log('[RECONNECT] trigger pipe disconnected');
    }

    // 2. Disconnect VCOIn and VCOOut
    try {
      if (this.input_pipe) {
        this.input_pipe.disconnect();
        log('[RECONNECT] VCOIn disconnected');
      }
      if (this.output_pipe && this.output_pipe !== this.input_pipe) {
        this.output_pipe.disconnect();
        log('[RECONNECT] VCOOut disconnected');
      }
    } catch (e) {
      log('[RECONNECT] pipe disconnect error: ' + (e as any).message);
    }

    mainWindow?.webContents.send('connection-changed', { isConnected: false });

    // 3. Wait to let OS/VCODisp release the pipes
    await new Promise((resolve) => setTimeout(resolve, 500));
    log('[RECONNECT] waited 500ms, reconnecting...');

    // 4. Re-init main pipes
    try {
      const res = await this.init();
      log('[RECONNECT] VCOIn/VCOOut reconnect result: ' + JSON.stringify(res));
    } catch (e) {
      log('[RECONNECT] VCOIn/VCOOut reconnect FAILED: ' + (e as any).message);
    }

    // 5. Re-start trigger listener if needed
    if (reopenTrigger) {
      this.startTriggerStableListener();
      log('[RECONNECT] trigger stable listener re-started');
    } else {
      log('[RECONNECT] trigger stable listener NOT re-started (FreshAI off)');
    }

    log('[RECONNECT] === Hard reconnect done ===');
  }

  /**
   * Enable or disable the trigger_stable listener at runtime (from UI toggle)
   */
  setTriggerStableEnabled(enabled: boolean) {
    if (enabled) {
      this.startTriggerStableListener();
      logTrigger('Trigger stable listener started');
    } else {
      if (this.triggerStableSub) {
        this.triggerStableSub.unsubscribe();
        this.triggerStableSub = null;
      }
      if (this.triggerStablePipe) {
        this.triggerStablePipe.disconnect();
        this.triggerStablePipe = null;
        logTrigger('Trigger stable pipe disconnected');
      }
      this.latestTriggerResult = null;
      logTrigger('Trigger stable listener stopped');
    }
  }

  /**
   * Send an "empty" Record 05 — unit_price=0, tare=0, empty article text.
   * Alternative reset approach: overwrite the article data with blanks instead
   * of standardizing via EOT. Whether this re-arms trigger_stable is unknown
   * (an empty Record 05 still technically SETS article data), hence the test.
   */
  async sendEmptyRecord05(): Promise<boolean> {
    log('[EMPTY R05] Sending Record 05 with empty fields (unit_price=0, tare=0, no article)');
    return this.setSettings({
      tare: 0,
      unit_price: 0,
      description_text: '',
      ean: '',
      should_print_barcode: false,
      should_print_additional_text: false,
    } as any);
  }

  /**
   * send settings to scale and check response
   */
  async setSettings(settings: ValidatedSettings): Promise<boolean> {
    const scaleSettings: Settings = {
      description_text: settings.description_text as string,
      tare: ScaleTranslator.translateFloatToString(settings.tare as number, 3, 4),
      unit_price: ScaleTranslator.translateFloatToString(settings.unit_price as number, 2, 6),
      should_print_barcode: settings.should_print_barcode as boolean,
      should_print_additional_text: settings.should_print_additional_text as boolean,
      ean: settings.ean as string,
    };
    const scaleResp = await this.requestScale(BufferTranslator.createSettingsRequest(scaleSettings));
    if (BufferTranslator.isNak(scaleResp)) {
      const why = await this.requestNakExplanation();
      throw BufferTranslator.parseNakReason(why);
    }
    if (BufferTranslator.isAck(scaleResp)) {
      stateService.setSettingState(scaleSettings);
      return true;
    } else {
      log('Unknown resp');
      log(scaleResp);
      return false;
    }
  }

  /**
   * display logic version number on scale and screen or hide it
   */
  async toggleLogicVersionDisplay(shouldBeShown: boolean, timeout?: number) {
    const { EOT, STX, D0, D1, D2, ESC, ETX } = _b;
    const hideQuery = Buffer.from([EOT, STX, D2, D0, ESC, D0, ETX]);

    const handleNak = async (request: Promise<Buffer>) => {
      const buf = await request;
      if (!BufferTranslator.isNak(buf)) return;
      const reason = await this.requestNakExplanation();
      throw BufferTranslator.parseNakReason(reason);
    };

    if (!shouldBeShown) return handleNak(this.requestScale(hideQuery));
    else {
      const showQuery = Buffer.from([EOT, STX, D2, D0, ESC, D1, ETX]);
      setTimeout(() => {
        // .catch is required — this is a floating promise; a reject here
        // (e.g. checksum error) would otherwise become an unhandledRejection.
        this.requestScale(hideQuery).catch((e) =>
          log('[logic-version] auto-hide failed: ' + ((e as any).message || e))
        );
      }, timeout);
      return handleNak(this.requestScale(showQuery));
    }
  }
}

export const scaleCommunicationService = new ScaleCommunicationService();
