import { FreshAIRecognitionResponse } from './FreshAI.type';

export type WeightSuccessResponse = {
  scale_status: string;
  weight: number;
  unit_price: number;
  selling_price: number;
  tare?: number;
};

export type WithReceiptInfo = {
  receipt_printed: boolean;
  receipt_print_errors?: any;
};

export type WithFreshAI = {
  recognition?: FreshAIRecognitionResponse | null;
};

export type WeightSuccessResponseWithReceiptInfo = WeightSuccessResponse & WithReceiptInfo & WithFreshAI;
