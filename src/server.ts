import express from 'express';
import morgan from 'morgan';
import { json, urlencoded } from 'body-parser';
import { router } from './views';
import multer from 'multer';
import { log } from './utils/logger';

export const app = express();

// Very early request logger — catches everything that reaches Express,
// even before body parsing. Lets us see if request arrived at all.
app.use((req, _res, next) => {
    log(`[INCOMING] ${req.method} ${req.originalUrl} from ${req.ip} origin="${req.headers.origin || '?'}" content-type="${req.headers['content-type'] || '?'}"`);
    next();
});

// CORS — accept all origins (local middleware, same-machine traffic only)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
        log(`[CORS] preflight OPTIONS ${req.originalUrl} → 204`);
        res.sendStatus(204);
        return;
    }
    next();
});

app.use(json());
app.use(morgan(`:remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length]`));
app.use(urlencoded({ extended: true }));
app.use(multer().any());
app.use('/', router);
