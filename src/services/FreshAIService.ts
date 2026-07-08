import http from 'http';
import { FreshAIBaseResponse, FreshAIRecognitionResponse } from '../types';
import { logFreshAI } from '../utils/logger';

class FreshAIService {
  private host = '127.0.0.1';
  private port = 9998;
  private path = '/FreshAI/api/v2/itemRecognition';

  private request<T>(body: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);

      const options: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path: this.path,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 10000,
      };

      const req = http.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData) as T;
            resolve(parsed);
          } catch (e) {
            reject(new Error(`FreshAI: invalid JSON response: ${responseData}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`FreshAI: connection error: ${e.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('FreshAI: request timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  async recognize(): Promise<FreshAIRecognitionResponse> {
    logFreshAI('FreshAI: triggering recognition...');
    const response = await this.request<FreshAIRecognitionResponse>({ cmd: 'recognize' });

    if (response.code !== 1000) {
      throw new Error(`FreshAI recognition error: ${response.code} - ${response.msg}`);
    }

    logFreshAI('FreshAI: recognition result -', JSON.stringify(response.value));
    return response;
  }

  async learn(sessionid: string, plu: string, name: string): Promise<FreshAIBaseResponse> {
    logFreshAI(`FreshAI: learning item ${plu} (${name}) for session ${sessionid}`);
    const response = await this.request<FreshAIBaseResponse>({
      cmd: 'notify',
      sessionid,
      param: { id: plu, name },
    });

    if (response.code !== 1000) {
      throw new Error(`FreshAI learning error: ${response.code} - ${response.msg}`);
    }

    return response;
  }

  async deleteAllLearning(): Promise<FreshAIBaseResponse> {
    logFreshAI('FreshAI: deleting ALL learning outcomes');
    const response = await this.request<FreshAIBaseResponse>({ cmd: 'deleteAllFeatures' });

    if (response.code !== 1000) {
      throw new Error(`FreshAI deleteAll error: ${response.code} - ${response.msg}`);
    }

    return response;
  }

  async deleteOneLearning(plu: string): Promise<FreshAIBaseResponse> {
    logFreshAI(`FreshAI: deleting learning for PLU ${plu}`);
    const response = await this.request<FreshAIBaseResponse>({
      cmd: 'deleteSingleFeature',
      param: { id: plu },
    });

    if (response.code !== 1000) {
      throw new Error(`FreshAI deleteSingle error: ${response.code} - ${response.msg}`);
    }

    return response;
  }
}

export const freshAIService = new FreshAIService();
