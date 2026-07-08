import { RequestHandler, Router } from 'express';
import { scaleCommunicationService } from '../services/ScaleCommunicationService';
import { BadRequestError, WeightSuccessResponseWithReceiptInfo } from '../types';
import { SettingSchema } from '../utils/settings.schema';
import { log } from '../utils/logger';
import { printReceipt } from '../utils/printer';
import { stateService } from '../services/StateService';

export const scaleRouter = Router();

/**
 * Parse "0"/"1"/"true"/"false" -> boolean, also accepts numbers.
 */
function toBool(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    return s === 'true' || s === '1' || s === 'yes' || s === 'ja';
  }
  return false;
}

function toNum(v: any, fallback = 0): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

const IsScaleConnectedMiddleware: RequestHandler = (req, res, next) => {
  log(`[HTTP] ${req.method} ${req.originalUrl} from ${req.ip} — pipe connected=${scaleCommunicationService.isConnected}`);
  // type=print bypasses scale — no pipe check needed
  if (req.body && (req.body.type === 'print' || req.body.type === 'PRINT')) {
    log('[HTTP] type=print → skip pipe-connected check');
    return next();
  }
  if (!scaleCommunicationService.isConnected) {
    log('[HTTP] !!! Rejected: pipes not connected');
    const response: BadRequestError = {
      message: 'App is not connected to scale (pipes)',
      error_code: 'ENOENT',
    };
    res.status(400).send(response);
  } else next();
};

const SettingsView: RequestHandler = async (req, res) => {
  log(`[HTTP] POST /scale/settings body=${JSON.stringify(req.body)}`);

  // Shortcut: if type=="print" — print receipt directly with provided values.
  // NO scale interaction at all (no Record 05, no VCODisp window, no keepalive).
  // We only compute net weight and print. This keeps VCODisp's trigger_stable
  // state machine completely untouched, so the AI scan cycle keeps working
  // continuously item after item.
  if (req.body && (req.body.type === 'print' || req.body.type === 'PRINT')) {
    log('[HTTP] /scale/settings → type=print, printing only (no scale/VCODisp interaction)');
    try {
      const rawWeight = toNum(req.body.weight);   // brutto from POS
      const unit_price = toNum(req.body.unit_price);
      const tare = toNum(req.body.tare);
      // POS sends gross weight; subtract tare ourselves so the receipt shows net.
      const weight = +Math.max(0, rawWeight - tare).toFixed(3);
      const selling_price = +(weight * unit_price).toFixed(2);
      const ean = req.body.ean ? String(req.body.ean) : '';
      const description_text = req.body.description_text || req.body.article_text || req.body.article || '';
      const should_print_barcode = toBool(req.body.should_print_barcode);
      const should_print_additional_text = req.body.should_print_additional_text === undefined
        ? true : toBool(req.body.should_print_additional_text);
      log(`[HTTP] (print mode) raw weight=${rawWeight}, tara=${tare} → net weight=${weight}, selling_price=${selling_price}`);

      // Push settings into stateService — printReceipt reads from there
      stateService.setSettingState({
        tare,
        unit_price,
        description_text,
        ean,
        should_print_barcode,
        should_print_additional_text,
      } as any);

      const weightPayload = {
        scale_status: 'kg; 3 decimal places',
        weight,
        unit_price,
        selling_price,
      };
      log(`[HTTP] /scale/settings (print mode) calling printReceipt with: ${JSON.stringify(weightPayload)}`);
      // Respect the Wiegebon UI toggle — if druk_type=Nein, printReceipt will skip.
      await printReceipt(weightPayload as any, false);
      log('[HTTP] /scale/settings (print mode) → 200 OK');
      res.sendStatus(200);
    } catch (e) {
      log(`[HTTP] /scale/settings (print mode) → 500 print failed: ${(e as any).message || e}`);
      res.status(500).send({
        message: 'Print failed',
        error_code: 'PRINT_FAILED',
        error: (e as any).message || String(e),
      });
    }
    return;
  }

  // Normalize body — POS sends "article" instead of "description_text", and "type" tag
  const normalized = { ...req.body };
  if (!normalized.description_text && normalized.article) {
    normalized.description_text = normalized.article;
    log(`[HTTP] /scale/settings normalized: article → description_text="${normalized.description_text}"`);
  }
  // Strip POS-specific fields that Joi shouldn't try to validate as settings
  delete normalized.type;
  delete normalized.weight;
  delete normalized.article;

  const data = SettingSchema.validate(normalized);
  if (data.error || data.errors) {
    log(`[HTTP] /scale/settings validation FAILED: ${JSON.stringify(data.error || data.errors)}`);
    const err: BadRequestError = {
      message: 'Validation failed',
      error_code: 'VALIDATION',
      error: { ...data.error, ...data.errors },
    };
    res.send(err);
  } else {
    scaleCommunicationService
      .setSettings(data.value)
      .then((_) => {
        log('[HTTP] /scale/settings → 200 OK');
        res.sendStatus(200);
      })
      .catch((err: BadRequestError) => {
        log(`[HTTP] /scale/settings → 409 ${JSON.stringify(err)}`);
        res.status(409).send(err);
      });
  }
};

const WeightView: RequestHandler = async (_, res) => {
  log('[HTTP] GET /scale/weight — calling getWeight()');
  const startedAt = Date.now();
  scaleCommunicationService
    .getWeight()
    .then((resp: WeightSuccessResponseWithReceiptInfo) => {
      const elapsed = Date.now() - startedAt;
      log(`[HTTP] GET /scale/weight → 200 OK (${elapsed}ms) body=${JSON.stringify(resp)}`);
      res.send(resp);
    })
    .catch((err: BadRequestError) => {
      const elapsed = Date.now() - startedAt;
      log(`[HTTP] GET /scale/weight → 409 (${elapsed}ms) err=${JSON.stringify(err)}`);
      res.status(409).send(err);
    });
};

const ToggleLogicVersionViewFactory = (isOn: boolean) => {
  const handler: RequestHandler = async (req, res) => {
    const timeout = req.body.timeout || 10000;
    scaleCommunicationService
      .toggleLogicVersionDisplay(isOn, timeout)
      .then((_) => res.sendStatus(200))
      .catch((err: BadRequestError) => {
        res.status(409).send(err);
      });
  };
  return handler;
};

const LatestView: RequestHandler = async (_, res) => {
  const result = scaleCommunicationService.getLatestTriggerResult();
  if (result) {
    res.send(result);
  } else {
    const err: BadRequestError = {
      message: 'No trigger_stable result available yet',
      error_code: 'NO_DATA',
    };
    res.status(404).send(err);
  }
};

scaleRouter.use(IsScaleConnectedMiddleware);
scaleRouter.post('/settings', SettingsView);
scaleRouter.get('/weight', WeightView);
scaleRouter.get('/latest', LatestView);
scaleRouter.post('/show-logic-version', ToggleLogicVersionViewFactory(true));
scaleRouter.post('/hide-logic-version', ToggleLogicVersionViewFactory(false));
