import express from 'express';
import morgan from 'morgan';
import { json, urlencoded } from 'body-parser';
import { router } from './views';
import multer from 'multer';
import { log } from './utils/logger';

export const app = express();

// [DIAG] Very early request logger — catches everything that reaches Express,
// even before body parsing. If a request hangs with NO [INCOMING] line, the
// request died BELOW Express (TCP/TLS/keep-alive layer), not in our code.
app.use((req, res, next) => {
    const startedAt = Date.now();
    log(`[INCOMING] ${req.method} ${req.originalUrl} from ${req.ip} origin="${req.headers.origin || '?'}" content-type="${req.headers['content-type'] || '?'}" conn="${req.headers.connection || '?'}"`);

    // [DIAG] Log how each request ENDS — including sockets that die with no
    // response. 'close' without 'finish' == client gave up / socket destroyed.
    let finished = false;
    res.on('finish', () => {
        finished = true;
        log(`[OUTGOING] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    res.on('close', () => {
        if (!finished) {
            log(`[ABORTED] ${req.method} ${req.originalUrl} — socket closed with NO response after ${Date.now() - startedAt}ms`);
        }
    });
    next();
});

app.use(json());
app.use(morgan(`:remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length]`));
app.use(urlencoded({ extended: true }));
app.use(multer().any());
app.use('/', router);
