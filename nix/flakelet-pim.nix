# flakelet module for the PIM MCP server over HTTP. It signs in to Stalwart
# with a password issued for it alone; TLS termination, the reverse proxy
# and firewall stay host configuration.
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
    username = {
      type = types.string;
      description = "Login name of the mail account.";
    };
    passwordFile = {
      type = types.string;
      description = "Host path of a password issued for this server alone, loaded with LoadCredential=; revoking it cuts the server off.";
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
        DynamicUser = true;
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
    in
    {
      services.${name} = {
        description = "PIM MCP server";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          PIM_SERVER_URL = options.serverUrl;
          PIM_USERNAME = options.username;
          # %d is the credentials directory, so secrets never enter the store or the environment.
          PIM_PASSWORD_FILE = "%d/password";
          PIM_TRANSPORT = "http";
          PIM_HTTP_HOST = options.listenAddress;
          PIM_HTTP_PORT = toString options.port;
          PIM_HTTP_ALLOWED_HOSTS = lib.concatStringsSep "," options.allowedHosts;
          PIM_HTTP_TOKEN_FILE = "%d/token";
          PIM_LOG_LEVEL = options.logLevel;
          PIM_WRITES = lib.concatStringsSep "," options.writes;
        };
        serviceConfig = hardening // {
          ExecStart = lib.getExe package;
          # systemd copies both at start: a new password takes a restart.
          LoadCredential = [
            "token:${options.tokenFile}"
            "password:${options.passwordFile}"
          ];
          Restart = "on-failure";
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
