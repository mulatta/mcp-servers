{
  lib,
  stdenvNoCC,
  bun,
  bun2nixLib,
  makeWrapper,
}:

let
  root = ../mcp_servers/youtube;
in
stdenvNoCC.mkDerivation {
  pname = "youtube-mcp";
  version = "0.0.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/bun.lock")
      (root + "/tsconfig.json")
      (root + "/src")
      (root + "/tests")
      (root + "/examples")
    ];
  };

  nativeBuildInputs = [
    bun2nixLib.hook
    makeWrapper
  ];

  bunDeps = bun2nixLib.fetchBunDeps {
    bunNix = root + "/bun.nix";
  };

  dontUseBunBuild = true;
  dontUseBunInstall = true;

  buildPhase = ''
    runHook preBuild
    bun build src/index.ts --target=bun --outfile dist/youtube-mcp.js
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    bun test tests/protocol
    runHook postCheck
  '';

  # Diagnostics were verified against bun's stdio pipes, so run on bun rather than node.
  installPhase = ''
    runHook preInstall
    install -Dm644 dist/youtube-mcp.js $out/lib/youtube-mcp/youtube-mcp.js
    makeWrapper ${lib.getExe bun} $out/bin/youtube-mcp \
      --add-flags "$out/lib/youtube-mcp/youtube-mcp.js"
    runHook postInstall
  '';

  # Listing tools needs no browser session, so it proves the bundle loads offline.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
      | $out/bin/youtube-mcp > tools.json
    grep -q youtube_get_watch_history tools.json
    runHook postInstallCheck
  '';

  meta = {
    description = "Read-only MCP server for a personal YouTube library";
    mainProgram = "youtube-mcp";
    inherit (bun.meta) platforms;
  };
}
