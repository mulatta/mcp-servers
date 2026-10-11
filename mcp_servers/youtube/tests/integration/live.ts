export {};

if (process.env.YOUTUBE_LIVE_READONLY !== "1") {
  console.error(
    "Live reads disabled. Obtain approval before setting YOUTUBE_LIVE_READONLY=1.",
  );
  process.exit(2);
}
const playlistId = process.env.YOUTUBE_LIVE_PLAYLIST_ID;
const expectedAccount = process.env.YOUTUBE_LIVE_ACCOUNT_ID;
if (
  !playlistId ||
  !/^[A-Za-z0-9_-]{2,150}$/.test(playlistId) ||
  !expectedAccount ||
  !/^UC[A-Za-z0-9_-]{22}$/.test(expectedAccount)
) {
  console.error(
    "Set YOUTUBE_LIVE_PLAYLIST_ID and YOUTUBE_LIVE_ACCOUNT_ID from the intended browser account.",
  );
  process.exit(2);
}

const { createReader } = await import("../../src/reader.ts");
const { toolNames } = await import("../../src/server.ts");
const { withDeadline } = await import("../../src/deadline.ts");
const { SafeError, safeError } = await import("../../src/errors.ts");
const { resultSchema } = await import("../../src/youtube/normalize.ts");

try {
  const reader = createReader();
  for (const name of toolNames) {
    const result = resultSchema.parse(
      await withDeadline(new AbortController().signal, 30_000, (signal) =>
        reader(
          name,
          {
            limit: 1,
            ...(name === "youtube_get_playlist"
              ? { playlist_id: playlistId }
              : {}),
          },
          signal,
        ),
      ),
    );
    if (result.account_id !== expectedAccount)
      throw new SafeError("ACCOUNT_CHANGED");
    // Report bounded evidence, not titles, IDs, history, or session material.
    console.log(
      `${name}: account matched; items=${result.items.length}; has_more=${result.has_more}`,
    );
  }
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
}
