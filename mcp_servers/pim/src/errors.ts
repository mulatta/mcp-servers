const messages = {
  AUTH_REQUIRED:
    "The mail server refused this server's password; it may have been revoked. The operator must issue a new one and restart the server.",
  NOT_FOUND:
    "The requested item does not exist or is not visible to this account.",
  INVALID_REQUEST: "The mail server rejected the request as invalid.",
  CURSOR_INVALID: "Cursor does not match this request.",
  PARTICIPANTS_REFUSED:
    "Events with participants are not written: saving one would send invitations. Nothing was changed.",
  NOT_A_DRAFT:
    "The email is not a draft in the Drafts mailbox. Nothing was changed.",
  NOT_IN_TRASH:
    "Only emails that are solely in Trash or Junk can be destroyed. Trash them first. Nothing was changed.",
  MAILBOX_NOT_EMPTY:
    "The mailbox still holds emails or child mailboxes. Nothing was changed.",
  WRITE_REJECTED: "The mail server refused the change. Nothing was changed.",
  RATE_LIMITED: "The mail server rate limited this request. Try again later.",
  UPSTREAM_CHANGED: "The mail server returned an unsupported response.",
  UPSTREAM_UNAVAILABLE: "The mail server is currently unavailable.",
  TIMEOUT: "Request timed out.",
  WRITE_OUTCOME_UNKNOWN:
    "The change was sent but its result is unknown. Read the target before retrying; repeating a create or send can duplicate it.",
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
