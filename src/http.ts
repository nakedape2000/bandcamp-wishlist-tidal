export interface HttpClientOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function request(
  url: string,
  init: RequestInit = {},
  options: HttpClientOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;

  for (let attempt = 0; ; attempt++) {
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }

    if (!retryable(response.status) || attempt >= retries) return response;
    const retryAfter = response.headers.get("retry-after");
    const numericDelay = retryAfter == null ? 0 : Number(retryAfter) * 1000;
    const dateDelay =
      retryAfter && Number.isNaN(Number(retryAfter))
        ? Date.parse(retryAfter) - Date.now()
        : 0;
    const retryDelay =
      Number.isFinite(numericDelay) && numericDelay >= 0
        ? numericDelay
        : Number.isFinite(dateDelay) && dateDelay >= 0
          ? dateDelay
          : 0;
    const delay = Math.max(retryDelay, baseDelayMs * 2 ** attempt);
    await sleep(delay);
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  options?: HttpClientOptions,
): Promise<T> {
  const response = await request(url, init, options);
  const body = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `HTTP ${response.status} for ${url}`,
      response.status,
      body,
      url,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(`Invalid JSON from ${url}`, response.status, body, url);
  }
}
