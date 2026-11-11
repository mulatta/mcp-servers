# Runs the flakelet artifact against a real Stalwart 0.15 on one VM: the
# operator's one-time device login through the login unit, then every
# tool over HTTP on a throwaway account, then a revoked sign-in.
{
  flakeletModule,
  artifact,
  driver,
  tokenFile,
  token,
}:
{ pkgs, ... }:
let
  # Stalwart checks addresses against the public suffix list, so a
  # reserved .test domain would leave the account without identities.
  address = "tester@example.org";
  friend = "friend@example.org";
  password = "vm-test-password";
  adminPassword = "vm-admin-password";
in
{
  name = "flakelet-pim";

  nodes.machine = {
    imports = [ flakeletModule ];
    virtualisation.memorySize = 2048;

    environment.etc.${pkgs.lib.removePrefix "/etc/" tokenFile} = {
      text = token;
      mode = "0400";
    };

    services.stalwart = {
      enable = true;
      # nixpkgs' cargoSetupHook links jemalloc from the system, which the
      # pinned stalwart_0_15 does not provide; the cask host carries the
      # same override. Drop once NixOS/nixpkgs#586026 reaches nixos-unstable.
      package = pkgs.stalwart_0_15.overrideAttrs (old: {
        buildInputs = old.buildInputs ++ [ pkgs.rust-jemalloc-sys ];
      });
      stateVersion = "25.05";
      settings = {
        server.hostname = "mail.example.test";
        server.listener.http = {
          bind = [ "127.0.0.1:8080" ];
          protocol = "http";
        };
        # The session's API URL must share the origin the server is configured with.
        http.url = "'http://127.0.0.1:8080'";
        # PostgreSQL for everything, as on the cask host. RocksDB, the
        # module default, crashes in malloc_usable_size with the jemalloc
        # override above.
        store.postgresql = {
          type = "postgresql";
          host = "/run/postgresql";
          port = 5432;
          database = "stalwart-mail";
          user = "stalwart-mail";
          # Peer authentication ignores this required field.
          password = "unused";
          tls.enable = false;
        };
        storage = {
          data = "postgresql";
          fts = "postgresql";
          blob = "postgresql";
          lookup = "postgresql";
          directory = "internal";
        };
        directory.internal = {
          type = "internal";
          store = "postgresql";
        };
        authentication.fallback-admin = {
          user = "admin";
          secret = adminPassword;
        };
        # As on the cask host: only registered OAuth clients may sign in.
        oauth.client-registration.require = true;
        # Every recipient is the local account; nothing leaves the VM.
        queue.strategy.route = "'local'";
        # The test needs no web UI; the webadmin bundle's build tool (trunk)
        # fails on the pinned nixpkgs until NixOS/nixpkgs#584299 reaches
        # nixos-unstable.
        webadmin.resource = pkgs.lib.mkForce "file:///var/empty/webadmin.zip";
      };
    };

    services.postgresql = {
      enable = true;
      ensureDatabases = [ "stalwart-mail" ];
      ensureUsers = [
        {
          name = "stalwart-mail";
          ensureDBOwnership = true;
        }
      ];
    };
    systemd.services.stalwart = {
      after = [ "postgresql.service" ];
      requires = [ "postgresql.service" ];
    };

    services.flakelets = {
      enable = true;
      services.pim-mcp.prebuilt = artifact;
    };
    systemd.services.flakelet-pim-mcp = {
      after = [ "stalwart.service" ];
      wants = [ "stalwart.service" ];
    };
  };

  testScript = ''
    import json
    import re

    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("stalwart.service")
    machine.wait_until_succeeds("curl -sf http://127.0.0.1:8080/.well-known/oauth-authorization-server", timeout=60)
    machine.succeed("systemctl start flakelet-pim-mcp.service", timeout=120)
    machine.succeed("systemctl is-active pim-mcp.service")

    def call(name, arguments="{}"):
        body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' % (name, arguments)
        return machine.succeed(
            "curl -sf -X POST http://127.0.0.1:8766/mcp "
            "-H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' "
            "-H 'Accept: application/json, text/event-stream' -H 'MCP-Protocol-Version: 2025-06-18' "
            f"--data-binary '{body}'"
        )

    def manage(principal):
        machine.succeed(
            "curl -sf -u admin:${adminPassword} -X POST http://127.0.0.1:8080/api/principal "
            f"-H 'Content-Type: application/json' -d '{json.dumps(principal)}'"
        )

    with subtest("account and OAuth client as provisioned on cask"):
        manage({"type": "domain", "name": "example.org"})
        manage({"type": "individual", "name": "tester", "secrets": ["${password}"],
                "emails": ["${address}"], "roles": ["user"]})
        manage({"type": "individual", "name": "friend", "secrets": ["${password}"],
                "emails": ["${friend}"], "roles": ["user"]})
        manage({"type": "oauthClient", "name": "pim-mcp"})

    with subtest("signed out until the operator logs in"):
        result = call("pim_list_mailboxes")
        assert "AUTH_REQUIRED" in result, result

    with subtest("device login through the login unit"):
        machine.succeed("systemctl start --no-block pim-mcp-login.service")
        line = machine.wait_until_succeeds(
            "journalctl -u pim-mcp-login.service -o cat | grep 'approve code'", timeout=60
        )
        match = re.search(r"approve code (\S+)\.", line)
        assert match, line
        code = match.group(1)
        # What the operator does in the browser: approve the code as the account.
        machine.succeed(
            "curl -sf -u tester:${password} -X POST http://127.0.0.1:8080/api/oauth "
            f"-H 'Content-Type: application/json' -d '{{\"type\":\"device\",\"code\":\"{code}\"}}'"
        )
        # The oneshot stays "activating" while it polls for the approval.
        machine.wait_until_succeeds(
            "test \"$(systemctl is-active pim-mcp-login.service)\" = inactive", timeout=60
        )
        result = machine.succeed("systemctl show -P Result pim-mcp-login.service").strip()
        assert result == "success", result
        journal = machine.succeed("journalctl -u pim-mcp-login.service -o cat")
        assert "Signed in as tester" in journal, journal
        mode = machine.succeed("stat -c '%a %U' /var/lib/private/pim-mcp/token.json").split()
        assert mode[0] == "600", mode

    with subtest("the running server picks up the login without a restart"):
        result = call("pim_list_mailboxes")
        assert '"role":"inbox"' in result, result

    with subtest("every tool against Stalwart"):
        output = machine.succeed(
            "PIM_VM_TOKEN_FILE=${tokenFile} PIM_VM_ADDRESS=${address} PIM_VM_FRIEND=${friend} "
            "${driver}/bin/pim-mcp-vm-driver 2>&1",
            timeout=600,
        )
        print(output)
        assert "all steps passed" in output

    with subtest("sent mail reached the other account"):
        def jmap_as_friend(request):
            return json.loads(machine.succeed(
                "curl -sf -u friend:${password} -H 'Content-Type: application/json' "
                f"-X POST http://127.0.0.1:8080/jmap/ -d '{json.dumps(request)}'"
            ))
        session = json.loads(machine.succeed("curl -sf -u friend:${password} http://127.0.0.1:8080/jmap/session"))
        account = session["primaryAccounts"]["urn:ietf:params:jmap:mail"]
        query = {"using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
                 "methodCalls": [["Email/query", {"accountId": account}, "0"]]}
        # Nothing else writes to this account: the composed message and the
        # draft sent later.
        for _ in range(60):
            ids = jmap_as_friend(query)["methodResponses"][0][1]["ids"]
            if len(ids) >= 2:
                break
            machine.sleep(1)
        assert len(ids) >= 2, ids

    with subtest("nothing secret reaches the journal"):
        journal = machine.succeed("journalctl -u pim-mcp.service -o cat")
        token_value = json.loads(machine.succeed("cat /var/lib/private/pim-mcp/token.json"))["refresh_token"]
        for secret in ["${token}", token_value, "${address}", "pim-vm-"]:
            assert secret not in journal, secret
        assert '"event":"server.start"' in journal

    with subtest("a revoked sign-in needs a new login"):
        machine.succeed("systemctl stop pim-mcp.service")
        machine.succeed(
            "sed -i 's/\"refresh_token\":\"[^\"]*\"/\"refresh_token\":\"revoked\"/' /var/lib/private/pim-mcp/token.json"
        )
        machine.succeed("systemctl start pim-mcp.service")
        machine.wait_until_succeeds("curl -s -o /dev/null http://127.0.0.1:8766/mcp", timeout=30)
        result = call("pim_list_mailboxes")
        assert "AUTH_REQUIRED" in result, result
  '';
}
