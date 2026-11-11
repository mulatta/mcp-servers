/**
 * Line edits to .env.test that keep its comments, order and unrelated keys,
 * so setup can record the test account without rewriting the user's file.
 */
const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = assignment.exec(line.trim());
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** Sets each key to its value, or removes it when the value is null. */
export function setEnv(
  text: string,
  updates: Record<string, string | null>,
): string {
  const pending = new Map(Object.entries(updates));
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const kept = lines.flatMap((line) => {
    const key = assignment.exec(line.trim())?.[1];
    if (key === undefined || !pending.has(key)) return [line];
    const value = pending.get(key);
    pending.delete(key);
    return value === null ? [] : [`${key}=${value}`];
  });
  for (const [key, value] of pending)
    if (value !== null) kept.push(`${key}=${value}`);
  return kept.length ? `${kept.join("\n")}\n` : "";
}

/**
 * What `live:setup check` writes once it has read the signed-in account:
 * the account pin, and no CDP URL that points the tests at another browser.
 */
export function accountUpdates(
  text: string,
  found: string,
  personal: string,
  browser: string,
): { refuse: string } | { updates: Record<string, string | null> } {
  if (!personal)
    return {
      refuse: "set YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID in .env.test first",
    };
  if (found === personal)
    return {
      refuse:
        "the test browser is signed into YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID; sign in to the test account instead",
    };
  const current = parseEnv(text);
  const updates: Record<string, string | null> = {};
  if (current.YOUTUBE_LIVE_ACCOUNT_ID !== found)
    updates.YOUTUBE_LIVE_ACCOUNT_ID = found;
  const url = current.YOUTUBE_LIVE_CDP_URL;
  if (url !== undefined && url !== "" && url !== browser)
    updates.YOUTUBE_LIVE_CDP_URL = null;
  return { updates };
}
