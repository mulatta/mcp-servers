# flakelet module for the PIM MCP server over HTTP. Ships the server unit
# and a `<name>-login` unit for the one-time OAuth device login; TLS
# termination, the reverse proxy and firewall stay host configuration.
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
      default = 8766;
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
    serverUrl = {
      type = types.string;
      description = "Origin of the Stalwart HTTP listener, such as https://mail.example.org.";
    };
    clientId = {
      type = types.string;
      default = "pim-mcp";
      description = "OAuth client ID registered in Stalwart.";
    };
    writes = {
      type = types.listOf (
        types.enum "writeGroup" [
          "flag"
          "organize"
          "delete"
          "draft"
          "send"
          "sieve"
          "vacation"
          "calendar"
          "contact"
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
      package = pkgs.callPackage ./pim.nix {
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
      hardening = {
        # Both units run as the same dynamic user, so the token file the
        # login unit writes belongs to the server.
        DynamicUser = true;
        User = name;
        StateDirectory = name;
        StateDirectoryMode = "0700";
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
      server = {
        PIM_SERVER_URL = options.serverUrl;
        PIM_CLIENT_ID = options.clientId;
      };
    in
    {
      services.${name} = {
        description = "PIM MCP server";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = server // {
          PIM_TRANSPORT = "http";
          PIM_HTTP_HOST = options.listenAddress;
          PIM_HTTP_PORT = toString options.port;
          PIM_HTTP_ALLOWED_HOSTS = lib.concatStringsSep "," options.allowedHosts;
          # %d is the credentials directory, so the token never enters the store or the environment.
          PIM_HTTP_TOKEN_FILE = "%d/token";
          PIM_LOG_LEVEL = options.logLevel;
          PIM_WRITES = lib.concatStringsSep "," options.writes;
        };
        serviceConfig = hardening // {
          ExecStart = lib.getExe package;
          LoadCredential = "token:${options.tokenFile}";
          Restart = "on-failure";
        };
      };

      # Started by hand once after deployment, and again whenever the
      # server reports AUTH_REQUIRED: it prints the address and code to
      # approve to the journal and writes the refresh token for the server,
      # which picks it up on its next request without a restart.
      services.login = {
        description = "PIM MCP server OAuth device login";
        after = [ "network.target" ];
        environment = server;
        serviceConfig = hardening // {
          Type = "oneshot";
          ExecStart = "${lib.getExe package} login";
          # The device code stays valid for 30 minutes.
          TimeoutStartSec = "35min";
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
