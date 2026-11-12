# Runs the flakelet artifact against a real Stalwart 0.15 on one VM, with
# accounts in a Kanidm LDAP directory that accepts only per-application
# passwords, as planned for the cask host: every tool over HTTP on a
# throwaway account signed in with its own application password, then
# revoking that password while the account's other clients keep working.
{
  flakeletModule,
  artifact,
  driver,
  tokenFile,
  token,
  username,
  passwordFile,
}:
{ pkgs, ... }:
let
  # Stalwart checks addresses against the public suffix list, so a
  # reserved .test domain would leave the account without identities.
  address = "${username}@example.org";
  friend = "friend@example.org";
  # Kanidm rejects weak passwords.
  unixPassword = "Quill-orbit-basalt-7392";
  # Each person's own sign-in to Kanidm, needed to issue and revoke the
  # person's application passwords.
  primaryPassword = "Lantern-mosaic-pebble-6150";
  adminPassword = "vm-admin-password";
  idmAdminPassword = "vm-idm-admin-password";

  certs = import "${pkgs.path}/nixos/tests/common/acme/server/snakeoil-certs.nix";
  idmDomain = certs.domain;
  baseDn = pkgs.lib.concatMapStringsSep "," (part: "dc=${part}") (pkgs.lib.splitString "." idmDomain);
  # Kanidm reads its key after dropping privileges; a store copy stays readable.
  idmCerts = pkgs.runCommand "kanidm-snakeoil-certs" { } ''
    mkdir $out
    cp ${certs.${idmDomain}.cert} $out/cert.pem
    cp ${certs.${idmDomain}.key} $out/key.pem
  '';
  # Written by the test once Kanidm has issued the service account token.
  ldapTokenFile = "/run/stalwart-ldap-token";
  mailUserFilter = "(memberof=spn=mail_users@${idmDomain},${baseDn})";
in
{
  name = "flakelet-pim";

  nodes.machine = {
    imports = [ flakeletModule ];
    virtualisation.memorySize = 3072;

    # The server starts at boot, before Kanidm can issue its password; the
    # test replaces this placeholder and restarts it.
    systemd.tmpfiles.rules = [ "f ${passwordFile} 0400 root root - placeholder" ];

    environment.etc.${pkgs.lib.removePrefix "/etc/" tokenFile} = {
      text = token;
      mode = "0400";
    };

    services.kanidm = {
      server.enable = true;
      client.enable = true;
      # The cask host's version; move with it (1.11 reaches end of life on
      # 2026-12-01).
      package = pkgs.kanidmWithSecretProvisioning_1_11;
      client.settings.uri = "https://${idmDomain}";
      server.settings = {
        domain = idmDomain;
        origin = "https://${idmDomain}";
        bindaddress = "127.0.0.1:443";
        ldapbindaddress = "127.0.0.1:3636";
        tls_chain = "${idmCerts}/cert.pem";
        tls_key = "${idmCerts}/key.pem";
      };
      provision = {
        enable = true;
        idmAdminPasswordFile = pkgs.writeText "idm-admin-password" idmAdminPassword;
        persons = {
          ${username} = {
            displayName = "Tester";
            mailAddresses = [ address ];
          };
          friend = {
            displayName = "Friend";
            mailAddresses = [ friend ];
          };
        };
        groups.mail_users.members = [
          username
          "friend"
        ];
      };
    };
    security.pki.certificateFiles = [ certs.ca.cert ];
    networking.hosts."127.0.0.1" = [ idmDomain ];

    services.stalwart = {
      enable = true;
      # nixpkgs' cargoSetupHook links jemalloc from the system, which the
      # pinned stalwart_0_15 does not provide; the cask host carries the
      # same override. Drop once NixOS/nixpkgs#586026 reaches nixos-unstable.
      package = pkgs.stalwart_0_15.overrideAttrs (old: {
        buildInputs = old.buildInputs ++ [ pkgs.rust-jemalloc-sys ];
      });
      stateVersion = "25.05";
      credentials.ldap-token = ldapTokenFile;
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
          directory = "kanidm";
        };
        # The cask host's directory, binding through the Kanidm application
        # "mail": Kanidm then accepts only that application's passwords,
        # which each person issues per client and can revoke one by one.
        # The entry UUID stands in for the account secret since Kanidm does
        # not expose password hashes over LDAP.
        directory.kanidm = {
          type = "ldap";
          url = "ldaps://127.0.0.1:3636";
          tls = {
            enable = true;
            allow-invalid-certs = true;
          };
          base-dn = baseDn;
          bind = {
            dn = "dn=token";
            secret = "%{file:/run/credentials/stalwart.service/ldap-token}%";
            auth = {
              method = "template";
              template = "spn={username}@${idmDomain},app=mail,${baseDn}";
              search = false;
            };
          };
          filter = {
            name = "(&(objectClass=person)${mailUserFilter}(|(uid=?)(spn=?)(name=?)(mail=?)))";
            email = "(&(objectClass=person)${mailUserFilter}(mail=?))";
          };
          attributes = {
            name = "name";
            email = "mail";
            description = "displayname";
            secret = "entryuuid";
            secret-changed = "entryuuid";
          };
        };
        authentication.fallback-admin = {
          user = "admin";
          secret = adminPassword;
        };
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
      after = [
        "postgresql.service"
        "kanidm.service"
      ];
      requires = [ "postgresql.service" ];
      # Started by the test once the LDAP bind token exists.
      wantedBy = pkgs.lib.mkForce [ ];
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
    machine.wait_for_unit("kanidm.service")

    # The test shell has no HOME, so the CLI gets an explicit session cache.
    kanidm_cache = "/root/kanidm-tokens"

    def kanidm(command):
        return machine.succeed(f"KANIDM_TOKEN_CACHE_PATH={kanidm_cache} kanidm {command} -D idm_admin 2>&1")

    def api(method, path, body=None, token=None, headers=""):
        auth = f"-H 'Authorization: Bearer {token}' " if token else ""
        data = f"-d '{json.dumps(body)}' " if body is not None else ""
        return json.loads(machine.succeed(
            f"curl -sf -X {method} https://${idmDomain}{path} {auth}{headers}-H 'Content-Type: application/json' {data}"
        ))

    def person_session(person):
        """Signs the person in with write access, which the CLI only grants after
        re-authenticating on a terminal."""
        step = {"init2": {"username": person, "issue": "token", "privileged": True}}
        api("POST", "/v1/auth", {"step": step}, headers="-D /tmp/kanidm-auth ")
        # Later steps name the session with the header the first answer set.
        session = machine.succeed("grep -i '^x-kanidm-auth-session-id:' /tmp/kanidm-auth").split(":", 1)[1].strip()
        header = f"-H 'X-KANIDM-AUTH-SESSION-ID: {session}' "
        api("POST", "/v1/auth", {"step": {"begin": "password"}}, headers=header)
        done = api("POST", "/v1/auth", {"step": {"cred": {"password": "${primaryPassword}"}}}, headers=header)
        return done["state"]["success"]

    def set_passwords(person):
        """Sets the person's own sign-in and Unix password, as the person would.

        The CLI prompts on a terminal; the REST API runs the same credential
        update session with the idm_admin session the CLI cached at login.
        """
        cache = json.loads(machine.succeed(f"cat {kanidm_cache}"))
        admin = cache["instances"][""]["tokens"]["idm_admin@${idmDomain}"]
        intent = api("GET", f"/v1/person/{person}/_credential/_update_intent", token=admin)["token"]
        session = api("POST", "/v1/credential/_exchange_intent", intent)[0]
        api("POST", "/v1/credential/_update", [{"password": "${primaryPassword}"}, session])
        api("POST", "/v1/credential/_update", [{"unixpassword": "${unixPassword}"}, session])
        api("POST", "/v1/credential/_commit", session)

    # Only a person may issue and revoke their own application passwords.
    def app_password(person, label):
        """Issues a password for the mail application as the person; returns (id, secret)."""
        issued = api(
            "POST", f"/scim/v1/Person/{person}/Application/_create_password",
            {"applicationUuid": application, "label": label}, token=person_session(person),
        )
        return issued["uuid"], issued["secret"]

    def revoke(person, password_id):
        machine.succeed(
            f"curl -sf -X DELETE https://${idmDomain}/scim/v1/Person/{person}/Application/{password_id} "
            f"-H 'Authorization: Bearer {person_session(person)}'"
        )

    def write_password(secret):
        machine.succeed(f"install -m 0400 /dev/null ${passwordFile} && printf %s '{secret}' > ${passwordFile}")

    def status(user, secret):
        return machine.succeed(
            f"curl -s -o /dev/null -w '%{{http_code}}' -u '{user}:{secret}' http://127.0.0.1:8080/jmap/session"
        )

    with subtest("people, the mail application and the LDAP bind token"):
        machine.succeed(f"KANIDM_PASSWORD=${idmAdminPassword} KANIDM_TOKEN_CACHE_PATH={kanidm_cache} kanidm login -D idm_admin")
        # Kanidm requires a second factor for people by default; the test
        # signs them in with a password alone, which the CLI can take
        # without a terminal.
        kanidm("group account-policy credential-type-minimum idm_all_persons any")
        kanidm("service-account create stalwart_ldap 'Stalwart Mail LDAP' idm_admins")
        kanidm("group add-members idm_people_pii_read stalwart_ldap")
        bind_token = kanidm("service-account api-token generate stalwart_ldap ldap-bind").strip().splitlines()[-1]
        machine.succeed(f"install -m 0400 /dev/null ${ldapTokenFile} && printf %s '{bind_token}' > ${ldapTokenFile}")
        kanidm("system application create mail Mail mail_users")
        described = kanidm("system application get mail")
        found = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", described)
        assert found, described
        application = found.group(0)
        for person in ["${username}", "friend"]:
            kanidm(f"person posix set {person}")
            set_passwords(person)
        pim_id, pim_secret = app_password("${username}", "pim")
        _, phone_secret = app_password("${username}", "phone")
        _, friend_secret = app_password("friend", "laptop")
        write_password(pim_secret)

    machine.succeed("systemctl start stalwart.service")
    machine.wait_for_unit("stalwart.service")
    machine.wait_until_succeeds("curl -sf http://127.0.0.1:8080/.well-known/jmap", timeout=60)

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

    with subtest("domain as provisioned on cask"):
        manage({"type": "domain", "name": "example.org"})

    with subtest("the server signs in with its application password"):
        machine.wait_for_unit("pim-mcp.service")
        machine.succeed("systemctl restart pim-mcp.service")
        machine.wait_until_succeeds("curl -s -o /dev/null http://127.0.0.1:8766/mcp", timeout=30)
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
                f"curl -sf -u 'friend:{friend_secret}' -H 'Content-Type: application/json' "
                f"-X POST http://127.0.0.1:8080/jmap/ -d '{json.dumps(request)}'"
            ))
        session = json.loads(machine.succeed(f"curl -sf -u 'friend:{friend_secret}' http://127.0.0.1:8080/jmap/session"))
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
        for secret in ["${token}", pim_secret, "${address}", "pim-vm-", bind_token]:
            assert secret not in journal, secret
        assert '"event":"server.start"' in journal

    with subtest("a Stalwart restart keeps the server signed in"):
        machine.succeed("systemctl restart stalwart.service")
        machine.wait_until_succeeds("curl -sf http://127.0.0.1:8080/.well-known/jmap", timeout=60)
        result = call("pim_list_mailboxes")
        assert '"role":"inbox"' in result, result

    with subtest("revoking the server's password cuts it off at once"):
        revoke("${username}", pim_id)
        result = call("pim_list_mailboxes")
        assert "AUTH_REQUIRED" in result, result
        # The account's other clients keep their own passwords.
        assert status("${username}", phone_secret) == "200"

    with subtest("a new password and a restart sign the server in again"):
        # systemd copies the credential at start, so a new password needs a
        # restart; until then the server stops asking Stalwart, whose
        # auto-ban counts failed sign-ins per address.
        _, renewed = app_password("${username}", "pim-renewed")
        write_password(renewed)
        assert "AUTH_REQUIRED" in call("pim_list_mailboxes")
        machine.succeed("systemctl restart pim-mcp.service")
        machine.wait_until_succeeds("curl -s -o /dev/null http://127.0.0.1:8766/mcp", timeout=30)
        result = call("pim_list_mailboxes")
        assert '"role":"inbox"' in result, result

    with subtest("the Unix password no longer signs in to mail"):
        assert status("${username}", "${unixPassword}") == "401"
  '';
}
