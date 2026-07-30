/**
 * Race a promise against a timeout. Rejects with a `TimeoutError` if `promise`
 * does not settle within `ms`. Edge-runtime safe (uses only setTimeout/Promise).
 *
 * Used in the auth middleware so a slow/unreachable Supabase call can never hang
 * the middleware to a Vercel 504 (MIDDLEWARE_INVOCATION_TIMEOUT): callers cap the
 * call and fail open. See src/middleware.ts.
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
