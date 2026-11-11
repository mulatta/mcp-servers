{
  lib,
  stdenvNoCC,
  bun,
  bun2nixLib,
  makeWrapper,
}:

let
  root = ../mcp_servers/pim;
in
stdenvNoCC.mkDerivation {
  pname = "pim-mcp";
  version = "0.0.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/bun.lock")
      (root + "/tsconfig.json")
      (root + "/src")
      (root + "/tests")
    ];
  };

  # The VM test drives the server with a bundled MCP client; it is not
  # part of the server.
  outputs = [
    "out"
    "driver"
  ];

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
    bun build src/index.ts --target=bun --outfile dist/pim-mcp.js
    bun build tests/vm/driver.ts --target=bun --outfile dist/vm-driver.js
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
    install -Dm644 dist/pim-mcp.js $out/lib/pim-mcp/pim-mcp.js
    makeWrapper ${lib.getExe bun} $out/bin/pim-mcp \
      --add-flags "$out/lib/pim-mcp/pim-mcp.js"
    install -Dm644 dist/vm-driver.js $driver/lib/vm-driver.js
    makeWrapper ${lib.getExe bun} $driver/bin/pim-mcp-vm-driver \
      --add-flags "$driver/lib/vm-driver.js"
    runHook postInstall
  '';

  # Listing tools needs no sign-in, so it proves the bundle loads offline.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
      | PIM_SERVER_URL=https://mail.example.test PIM_STATE_DIR=$TMPDIR/state \
        $out/bin/pim-mcp > tools.json
    grep -q pim_search_emails tools.json
    runHook postInstallCheck
  '';

  meta = {
    description = "MCP server for a Stalwart mail, calendar and contacts account over JMAP";
    mainProgram = "pim-mcp";
    inherit (bun.meta) platforms;
  };
}
