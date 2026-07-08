export type FreshAIRecognitionItem = {
  plu: string;
  confidence: number;
};

export type FreshAIRecognitionResponse = {
  code: number;
  msg: string;
  sessionid: string;
  value: FreshAIRecognitionItem[];
};

export type FreshAIBaseResponse = {
  code: number;
  msg: string;
};
