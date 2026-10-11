import { SafeError } from "../errors.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  const t = record(value);
  if (typeof t.simpleText === "string") return t.simpleText;
  return Array.isArray(t.runs)
    ? t.runs
        .map((r) => record(r).text)
        .filter((x) => typeof x === "string")
        .join("")
    : "";
}
const blocked = /not a bot|unusual traffic|captcha/i;

export async function checkResponse(response: Response): Promise<void> {
  const body = await response.clone().text();
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(body));
  } catch {
    if (blocked.test(body)) throw new SafeError("UPSTREAM_BLOCKED");
    if (response.status === 401) throw new SafeError("AUTH_REQUIRED");
    if (response.status === 429) throw new SafeError("RATE_LIMITED");
    if (response.status === 403) throw new SafeError("PLAYLIST_UNAVAILABLE");
    throw new SafeError(
      response.ok ? "UPSTREAM_CHANGED" : "UPSTREAM_UNAVAILABLE",
    );
  }
  const error = record(data.error),
    playback = record(data.playabilityStatus);
  const alerts = Array.isArray(data.alerts)
    ? data.alerts.map((a) => record(record(a).alertRenderer))
    : [];
  const messages = [
    error.message,
    playback.reason,
    ...alerts.map((a) => text(a.text)),
  ];
  if (messages.some((m) => typeof m === "string" && blocked.test(m)))
    throw new SafeError("UPSTREAM_BLOCKED");
  if (
    response.status === 401 ||
    error.status === "UNAUTHENTICATED" ||
    playback.status === "LOGIN_REQUIRED"
  )
    throw new SafeError("AUTH_REQUIRED");
  if (response.status === 429 || error.status === "RESOURCE_EXHAUSTED")
    throw new SafeError("RATE_LIMITED");
  if (response.status === 403 || error.status === "PERMISSION_DENIED")
    throw new SafeError("PLAYLIST_UNAVAILABLE");
  if (alerts.some((a) => a.type === "ERROR")) {
    if (
      messages.some(
        (m) =>
          typeof m === "string" &&
          /playlist.*(not exist|private|unavailable)/i.test(m),
      )
    )
      throw new SafeError("PLAYLIST_UNAVAILABLE");
    throw new SafeError("UPSTREAM_CHANGED");
  }
  if (!response.ok) throw new SafeError("UPSTREAM_UNAVAILABLE");
  if (data.error) throw new SafeError("UPSTREAM_CHANGED");
}
