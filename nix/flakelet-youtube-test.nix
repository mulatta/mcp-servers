# Activates the flakelet artifact the way a host would, so the hardening,
# credential loading and health check are exercised on a real systemd.
{
  flakeletModule,
  artifact,
  tokenFile,
  token,
  host,
}:
{ pkgs, ... }:
let
  rpc =
    method: params:
    pkgs.writeText "youtube-mcp-${builtins.replaceStrings [ "/" ] [ "-" ] method}.json" (
      builtins.toJSON {
        jsonrpc = "2.0";
        id = 1;
        inherit method params;
      }
    );
  curl = body: ''
    ${pkgs.curl}/bin/curl -sf -X POST http://127.0.0.1:8765/mcp \
      -H 'Host: ${host}' -H 'Authorization: Bearer ${token}' \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -H 'MCP-Protocol-Version: 2025-06-18' --data-binary @${body}
  '';
in
{
  name = "flakelet-youtube";

  nodes.machine = {
    imports = [ flakeletModule ];
    environment.etc.${pkgs.lib.removePrefix "/etc/" tokenFile} = {
      text = token;
      mode = "0400";
    };
    services.flakelets = {
      enable = true;
      services.youtube-mcp.prebuilt = artifact;
    };
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")
    # Activation runs the health check and rolls back if it fails.
    machine.succeed("systemctl start flakelet-youtube-mcp.service", timeout=120)
    machine.succeed("systemctl is-active youtube-mcp.service")

    tools = machine.succeed("""${curl (rpc "tools/list" { })}""")
    for name in ["youtube_list_playlists", "youtube_get_playlist", "youtube_get_watch_later",
                 "youtube_get_liked_videos", "youtube_get_watch_history"]:
        assert name in tools, tools

    # No browser in the VM: the read must fail closed with a safe code.
    result = machine.succeed("""${
      curl (
        rpc "tools/call" {
          name = "youtube_get_watch_later";
          arguments.limit = 1;
        }
      )
    }""")
    assert "BROWSER_UNAVAILABLE" in result and '"isError":true' in result, result

    journal = machine.succeed("journalctl -u youtube-mcp.service -u youtube-mcp-health.service")
    assert "${token}" not in journal
    assert '"event":"server.start"' in journal, journal
  '';
}
