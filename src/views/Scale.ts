import { RequestHandler, Router } from 'express';
import { scaleCommunicationService } from '../services/ScaleCommunicationService';
import { BadRequestError, WeightSuccessResponseWithReceiptInfo } from '../types';
import { SettingSchema } from '../utils/settings.schema';
import { log } from '../utils/logger';

export const scaleRouter = Router();

const IsScaleConnectedMiddleware: RequestHandler = (req, res, next) => {
  log(`[HTTP] ${req.method} ${req.originalUrl} from ${req.ip} — pipe connected=${scaleCommunicationService.isConnected}`);
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
  const startedAt = Date.now();
  const data = SettingSchema.validate(req.body);
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
        log(`[HTTP] /scale/settings → 200 OK (${Date.now() - startedAt}ms)`);
        res.sendStatus(200);
      })
      .catch((err: BadRequestError) => {
        log(`[HTTP] /scale/settings → 409 (${Date.now() - startedAt}ms) ${JSON.stringify(err)}`);
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
      log(`[HTTP] GET /scale/weight → 200 OK (${Date.now() - startedAt}ms) body=${JSON.stringify(resp)}`);
      res.send(resp);
    })
    .catch((err: BadRequestError) => {
      log(`[HTTP] GET /scale/weight → 409 (${Date.now() - startedAt}ms) err=${JSON.stringify(err)}`);
      res.status(409).send(err);
    });
};

const ToggleLogicVersionViewFactory = (isOn: boolean) => {
  const handler: RequestHandler = async (req, res) => {
    const timeout = req.body.timeout || 10000;
    log(`[HTTP] POST /scale/${isOn ? 'show' : 'hide'}-logic-version timeout=${timeout}`);
    scaleCommunicationService
      .toggleLogicVersionDisplay(isOn, timeout)
      .then((_) => res.sendStatus(200))
      .catch((err: BadRequestError) => {
        log(`[HTTP] /scale/logic-version → 409 ${JSON.stringify(err)}`);
        res.status(409).send(err);
      });
  };
  return handler;
};

scaleRouter.use(IsScaleConnectedMiddleware);
scaleRouter.post('/settings', SettingsView);
scaleRouter.get('/weight', WeightView);
scaleRouter.post('/show-logic-version', ToggleLogicVersionViewFactory(true));
scaleRouter.post('/hide-logic-version', ToggleLogicVersionViewFactory(false));
