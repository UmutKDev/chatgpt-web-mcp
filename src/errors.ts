export type ErrorCode =
  | "LOGIN_REQUIRED"
  | "BLOCKED_BY_CHALLENGE"
  | "RATE_LIMITED"
  | "CONTENT_REFUSED"
  | "GENERATION_TIMEOUT"
  | "NO_IMAGE_RETURNED"
  | "UPLOAD_FAILED"
  | "BROWSER_START_FAILED"
  | "NAVIGATION_FAILED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "QUEUE_FULL"
  | "CANCELLED"
  | "INTERNAL";

/** An error whose message is safe to show to the MCP caller. */
export class UserFacingError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  constructor(message: string, code: ErrorCode, opts: { hint?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "UserFacingError";
    this.code = code;
    this.hint = opts.hint;
    this.retryable = opts.retryable ?? false;
  }
}

export function toUserFacing(err: unknown): UserFacingError {
  if (err instanceof UserFacingError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/Target (page|closed)|browser has been closed|context.*closed/i.test(message)) {
    return new UserFacingError("The browser session closed unexpectedly. It will be restarted on the next call.", "BROWSER_START_FAILED", {
      retryable: true,
      cause: err,
    });
  }
  return new UserFacingError("Unexpected internal error while talking to ChatGPT.", "INTERNAL", { retryable: true, cause: err });
}
