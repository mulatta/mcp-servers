# Library fixture provenance

These JSON files retain structural facts from public response samples; they
are not personal account captures from this project. All titles/bylines/group
labels are replaced with `Fixture`, all IDs with generated fixture IDs, and
all continuation tokens with `fixture-next`. URLs, thumbnails, account data,
menus, tracking, commands other than continuation, and unrelated UI are removed.
No source implementation code or original creative text is included.

- `history.json` and `playlist.json`: response layout inspected from
  `TeamPiped/rustypipe` at `3f1491263929c22036429b665e370fdd2f066017`, paths
  `testfiles/userdata/history.json` and
  `testfiles/playlist/playlist_20241011_pageheader.json` (GPL-3.0 repository).
- `playlists.json`: WEB aggregation layout inspected from
  `lupclky/introvert-player` at `4324c55194b45c5cfcb6b12869991a43246db393`, path
  `scratch/playlists_initial.json`.

Tests derive bounded empty, duplicate, private/deleted, malformed and
continuation cases from these sanitized structural fixtures. WL and LL use
playlist-content fixtures with the requested browse ID asserted at the HTTP
boundary; these are not claimed to be captures of those private lists.
Account settings fixture in `../account.ts` is synthetic and source-derived,
not a captured response. Live account compatibility remains unverified.
