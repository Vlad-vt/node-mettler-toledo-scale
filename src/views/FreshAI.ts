import { RequestHandler, Router } from 'express';
import { freshAIService } from '../services/FreshAIService';
import { BadRequestError } from '../types';
import { log } from '../utils/logger';

export const freshAIRouter = Router();

const RecognizeView: RequestHandler = async (req, res) => {
  log(`[HTTP] POST /freshai/recognize from ${req.ip}`);
  const startedAt = Date.now();
  try {
    const result = await freshAIService.recognize();
    const elapsed = Date.now() - startedAt;
    log(`[HTTP] /freshai/recognize → 200 OK (${elapsed}ms) value_count=${result.value?.length || 0}`);
    res.send(result);
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    log(`[HTTP] /freshai/recognize → 409 (${elapsed}ms) err=${(err as any).message || err}`);
    const error: BadRequestError = {
      message: (err as any).message || 'FreshAI recognition failed',
      error_code: 'FRESHAI_RECOGNIZE',
    };
    res.status(409).send(error);
  }
};

const LearnView: RequestHandler = async (req, res) => {
  const { sessionid, plu, name } = req.body;

  if (!sessionid || !plu || !name) {
    const error: BadRequestError = {
      message: 'Missing required fields: sessionid, plu, name',
      error_code: 'VALIDATION',
    };
    res.status(400).send(error);
    return;
  }

  try {
    const result = await freshAIService.learn(sessionid, plu, name);
    res.send(result);
  } catch (err) {
    const error: BadRequestError = {
      message: (err as any).message || 'FreshAI learning failed',
      error_code: 'FRESHAI_LEARN',
    };
    res.status(409).send(error);
  }
};

const DeleteAllLearningView: RequestHandler = async (_, res) => {
  try {
    const result = await freshAIService.deleteAllLearning();
    res.send(result);
  } catch (err) {
    const error: BadRequestError = {
      message: (err as any).message || 'FreshAI delete all failed',
      error_code: 'FRESHAI_DELETE_ALL',
    };
    res.status(409).send(error);
  }
};

const DeleteOneLearningView: RequestHandler = async (req, res) => {
  const { plu } = req.params;

  if (!plu) {
    const error: BadRequestError = {
      message: 'Missing PLU parameter',
      error_code: 'VALIDATION',
    };
    res.status(400).send(error);
    return;
  }

  try {
    const result = await freshAIService.deleteOneLearning(plu);
    res.send(result);
  } catch (err) {
    const error: BadRequestError = {
      message: (err as any).message || 'FreshAI delete one failed',
      error_code: 'FRESHAI_DELETE_ONE',
    };
    res.status(409).send(error);
  }
};

freshAIRouter.post('/recognize', RecognizeView);
freshAIRouter.post('/learn', LearnView);
freshAIRouter.delete('/learning', DeleteAllLearningView);
freshAIRouter.delete('/learning/:plu', DeleteOneLearningView);
