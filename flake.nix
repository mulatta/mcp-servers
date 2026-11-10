{
  description = "MCP servers for personal use.";

  nixConfig.allow-import-from-derivation = false;

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flakelet = {
      url = "github:Mic92/flakelet";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    bun2nix = {
      # Fork accepts bun.lock version 2: https://github.com/nix-community/bun2nix/pull/110
      url = "github:Mic92/bun2nix/llm-agents";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
      bun2nix,
      flakelet,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      inherit (nixpkgs) lib;

      eachSystem = lib.genAttrs systems;

      pkgsFor = eachSystem (system: import nixpkgs { inherit system; });

      treefmtEval = eachSystem (system: treefmt-nix.lib.evalModule pkgsFor.${system} ./nix/treefmt.nix);

      packages = eachSystem (
        system:
        let
          pkgs = pkgsFor.${system};
        in
        {
          youtube = pkgs.callPackage ./nix/youtube.nix {
            bun2nixLib = (bun2nix.overlays.default pkgs pkgs).bun2nix;
          };
        }
      );

      devShells = eachSystem (
        system:
        import ./nix/shell.nix {
          pkgs = pkgsFor.${system};
        }
      );
    in

    {
      inherit devShells packages;

      # Run on a host with flakelet (https://github.com/Mic92/flakelet): the
      # server updates from this flake independently of the host system.
      flakelets.youtube = import ./nix/flakelet-youtube.nix { inherit bun2nix; };

      checks = eachSystem (
        system:
        {
          formatting = treefmtEval.${system}.config.build.check self;
        }
        // lib.mapAttrs' (name: package: lib.nameValuePair "package-${name}" package) packages.${system}
        // lib.mapAttrs' (name: shell: lib.nameValuePair "devshell-${name}" shell) devShells.${system}
        // lib.optionalAttrs pkgsFor.${system}.stdenv.hostPlatform.isLinux (
          let
            # Test-only credential; the VM serves no real account.
            flakeletTest = {
              tokenFile = "/etc/youtube-mcp-token";
              token = "flakelet-vm-test-token-0123456789abcdef";
              host = "youtube-mcp.example";
            };
            # Renders the units as a host would, so option or unit-key mistakes fail here.
            artifact = flakelet.lib.buildArtifact pkgsFor.${system} {
              name = "youtube-mcp";
              module = self.flakelets.youtube;
              settings = {
                inherit (flakeletTest) tokenFile;
                allowedHosts = [ flakeletTest.host ];
              };
            };
          in
          {
            flakelet-youtube = artifact;
            vm-flakelet-youtube = pkgsFor.${system}.testers.runNixOSTest (
              import ./nix/flakelet-youtube-test.nix (
                flakeletTest
                // {
                  inherit artifact;
                  flakeletModule = flakelet.nixosModules.flakelet;
                }
              )
            );
          }
        )
      );

      formatter = eachSystem (system: treefmtEval.${system}.config.build.wrapper);
    };
}
