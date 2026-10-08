import { sanitizeText } from '../redactor.js';
import type { ActiveHttpRequest, ActiveHttpResponse } from './types.js';

/** Deliberately excludes request bodies, headers, query strings and response data. */
export class ActiveRequestError extends Error {
  readonly diagnostic: {
    method: string;
    endpoint: string;
    httpStatus: number | null;
    businessCode: number | string | null;
    serverMessage: string | null;
  };

  constructor(
    message: string,
    request: ActiveHttpRequest,
    response?: ActiveHttpResponse,
  ) {
    const url = new URL(request.url);
    const body = response?.body;
    const record =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const code = record.code;
    const serverMessage = [record.msg, record.message, record.detail].find(
      (value) => typeof value === 'string',
    );
    const endpoint = `${url.origin}${url.pathname}`;
    super(
      `${sanitizeText(message).slice(0, 512)} [${request.method} ${endpoint}]`,
    );
    this.name = 'ActiveRequestError';
    this.diagnostic = {
      method: request.method,
      endpoint,
      httpStatus: response?.status ?? null,
      businessCode:
        typeof code === 'number'
          ? code
          : typeof code === 'string'
            ? sanitizeText(code).slice(0, 128)
            : null,
      serverMessage:
        typeof serverMessage === 'string'
          ? sanitizeText(serverMessage).slice(0, 1024)
          : null,
    };
  }
}
