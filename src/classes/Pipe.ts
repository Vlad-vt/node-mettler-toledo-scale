import net, { Socket } from 'net';
import { Observable, fromEvent, BehaviorSubject, Subject } from 'rxjs';
import { log } from '../utils/logger';

// handles socket connection for a single pipe
export class Pipe {
  public socket!: Socket;
  public is_connected$ = new BehaviorSubject(false);
  public errors$ = new Subject<Error>();
  public data$!: Observable<Buffer>;

  constructor(private path: string) {}

  connect() {
    // [DIAG] logging added — connect logic itself is unchanged
    log(`[PIPE] connect() -> ${this.path}`);
    this.socket = net.connect(this.path);
    this.socket.on('ready', () => {
      log(`[PIPE] READY ${this.path}`);
      this.is_connected$.next(true);
    });
    this.socket.on('close', () => {
      log(`[PIPE] CLOSE ${this.path}`);
      this.is_connected$.next(false);
    });
    this.socket.on('error', err => {
      log(`[PIPE] ERROR ${this.path}: ${err && err.message ? err.message : err}`);
      this.is_connected$.next(false);
      this.errors$.next(err);
    });
    // [DIAG] extra observation only — does not affect the data$ stream below
    this.socket.on('end', () => log(`[PIPE] END (server closed write side) ${this.path}`));
    this.data$ = fromEvent(this.socket, 'data');
  }

  disconnect() {
    log(`[PIPE] disconnect() ${this.path}`);
    if(this.socket) {
      this.socket.end();
      // 👇 dont think this is required
      // this.socket.removeAllListeners();
    }
  }
}
