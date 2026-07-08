import net, { Socket } from 'net';
import { Observable, fromEvent, BehaviorSubject, Subject } from 'rxjs';
import { log } from '../utils/logger';

// handles socket connection for a single pipe
export class Pipe {
  public socket!: Socket;
  public is_connected$ = new BehaviorSubject(false);
  public errors$ = new Subject<Error>();
  public data$!: Observable<Buffer>;

  private connectTimer: NodeJS.Timeout | null = null;
  private settled = false;

  constructor(private path: string) {}

  connect() {
    log(`[PIPE] connecting to ${this.path}`);
    this.settled = false;
    this.socket = net.connect(this.path);

    // Short connect timeout. The default OS timeout for a named-pipe connect is
    // ~30s, which is why a stuck connection used to hang for half a minute and
    // then fire ETIMEDOUT. We cap it at 5s and destroy the socket so it does
    // not linger as an orphaned connection attempt.
    this.connectTimer = setTimeout(() => {
      if (this.settled) return;
      log(`[PIPE] connect timeout (5s): ${this.path} → destroying socket`);
      this.settled = true;
      try { this.socket.destroy(); } catch (e) {}
      this.is_connected$.next(false);
      this.errors$.next(new Error('connect timeout'));
    }, 5000);

    this.socket.on('ready', () => {
      log(`[PIPE] ready: ${this.path}`);
      this.settled = true;
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.is_connected$.next(true);
    });
    this.socket.on('close', (hadError) => {
      log(`[PIPE] close: ${this.path} hadError=${hadError}`);
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.is_connected$.next(false);
    });
    this.socket.on('error', err => {
      log(`[PIPE] error: ${this.path} → ${err.message}`);
      this.settled = true;
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.is_connected$.next(false);
      this.errors$.next(err);
    });
    this.socket.on('end', () => log(`[PIPE] end: ${this.path}`));
    this.socket.on('timeout', () => log(`[PIPE] timeout: ${this.path}`));
    this.data$ = fromEvent(this.socket, 'data');
  }

  disconnect() {
    log(`[PIPE] disconnect requested: ${this.path}`);
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.socket) {
      // Use destroy() (not end()) so a socket that is still in the "connecting"
      // state is actually torn down. end() only closes an ESTABLISHED socket and
      // leaves a pending connect attempt alive — that is what caused orphaned
      // sockets to hang and fire ETIMEDOUT ~30s later.
      try { this.socket.destroy(); } catch (e) {}
    }
    this.is_connected$.next(false);
  }
}
