const messages = {
  BROWSER_UNAVAILABLE:
    "Browser session unavailable. Check Neko and the CDP connection.",
  AUTH_REQUIRED: "Sign in to YouTube in Neko, then try again.",
  ACCOUNT_CHANGED:
    "Browser account changed. Confirm the account and restart this server.",
  CURSOR_INVALID: "Cursor does not match this request.",
  CURSOR_EXPIRED: "Cursor expired. Start again without a cursor.",
  PLAYLIST_UNAVAILABLE: "Playlist is unavailable to this account.",
  RATE_LIMITED: "YouTube rate limited this request. Try again later.",
  UPSTREAM_BLOCKED: "YouTube blocked this request.",
  UPSTREAM_CHANGED: "YouTube returned an unsupported response.",
  UPSTREAM_UNAVAILABLE: "YouTube data is currently unavailable.",
  TIMEOUT: "Request timed out.",
} as const;
export type ErrorCode = keyof typeof messages;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

export class SafeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
    this.name = "SafeError";
  }
}

export function safeError(error: unknown): SafeError {
  return error instanceof SafeError
    ? new SafeError(error.code)
    : new SafeError("UPSTREAM_UNAVAILABLE");
}

export function errorResult(error: unknown) {
  const { code, message } = safeError(error);
  return {
    isError: true,
    content: [
      { type: "text" as const, text: JSON.stringify({ code, message }) },
    ],
  };
}
