# flakelet module for the YouTube MCP server over HTTP. Ships only the
# unit; TLS termination, the reverse proxy and firewall stay host
# configuration.
{ bun2nix }:
{ types, ... }:
{
  options = {
    listenAddress = {
      type = types.string;
      default = "127.0.0.1";
      description = "Address of the plain-HTTP listener; keep it on loopback behind a TLS proxy.";
    };
    port = {
      type = types.int;
      default = 8765;
      description = "Port of the plain-HTTP listener.";
    };
    allowedHosts = {
      type = types.listOf types.string;
      default = [
        "localhost"
        "127.0.0.1"
      ];
      description = "Hostnames accepted in the Host header; the first one is used by the health check.";
    };
    tokenFile = {
      type = types.string;
      description = "Host path of the bearer token file, loaded with LoadCredential=.";
    };
    cdpUrl = {
      type = types.string;
      default = "http://127.0.0.1:9222";
      description = "Chrome DevTools Protocol endpoint of the signed-in browser.";
    };
    writes = {
      type = types.listOf (
        types.enum "writeGroup" [
          "playlist"
          "rating"
          "subscription"
          "notification"
          "all"
        ]
      );
      default = [ ];
      description = "Write tool groups to expose; empty keeps the server read-only.";
    };
    logLevel = {
      type = types.enum "logLevel" [
        "error"
        "warn"
        "info"
        "debug"
      ];
      default = "info";
    };
  };

  impl =
    { options, inputs }:
    let
      inherit (inputs.nixpkgs) pkgs lib;
      inherit (inputs.flakelet) name;
      # Built against the host's nixpkgs like every flakelet; bun2nix only
      # contributes its library.
      package = pkgs.callPackage ./youtube.nix {
        bun2nixLib = (bun2nix.overlays.default pkgs pkgs).bun2nix;
      };
      probeAddress =
        if options.listenAddress == "0.0.0.0" then
          "127.0.0.1"
        else if options.listenAddress == "::" then
          "[::1]"
        else if lib.hasInfix ":" options.listenAddress then
          "[${options.listenAddress}]"
        else
          options.listenAddress;
    in
    {
      services.${name} = {
        description = "YouTube MCP server";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          YOUTUBE_TRANSPORT = "http";
          YOUTUBE_HTTP_HOST = options.listenAddress;
          YOUTUBE_HTTP_PORT = toString options.port;
          YOUTUBE_HTTP_ALLOWED_HOSTS = lib.concatStringsSep "," options.allowedHosts;
          # %d is the credentials directory, so the token never enters the store or the environment.
          YOUTUBE_HTTP_TOKEN_FILE = "%d/token";
          YOUTUBE_CDP_URL = options.cdpUrl;
          YOUTUBE_LOG_LEVEL = options.logLevel;
          YOUTUBE_WRITES = lib.concatStringsSep "," options.writes;
        };
        serviceConfig = {
          ExecStart = lib.getExe package;
          DynamicUser = true;
          LoadCredential = "token:${options.tokenFile}";
          Restart = "on-failure";
          UMask = "0077";
          CapabilityBoundingSet = "";
          NoNewPrivileges = true;
          PrivateDevices = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          ProtectClock = true;
          ProtectControlGroups = true;
          ProtectHostname = true;
          ProtectKernelLogs = true;
          ProtectKernelModules = true;
          ProtectKernelTunables = true;
          ProtectProc = "invisible";
          ProcSubset = "pid";
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
            "AF_UNIX"
          ];
          RestrictNamespaces = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          LockPersonality = true;
          SystemCallArchitectures = "native";
          SystemCallFilter = [
            "@system-service"
            "~@privileged"
          ];
        };
      };

      # An anonymous request must reach the auth check: 401 proves the
      # process serves and that the first allowed host passes the Host check,
      # without the probe needing the token.
      healthCheck = pkgs.writeShellScript "${name}-health" ''
        status=$(${lib.getExe pkgs.curl} -s --retry 5 --retry-connrefused --retry-delay 1 --max-time 5 \
          -o /dev/null -w '%{http_code}' -X POST \
          -H ${lib.escapeShellArg "Host: ${lib.head options.allowedHosts}"} \
          http://${probeAddress}:${toString options.port}/mcp)
        [ "$status" = 401 ] || { echo "unexpected status $status" >&2; exit 1; }
      '';
    };
}
