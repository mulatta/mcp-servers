{
  description = "MCP servers for personal use.";

  nixConfig.allow-import-from-derivation = false;

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
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

      checks = eachSystem (
        system:
        {
          formatting = treefmtEval.${system}.config.build.check self;
        }
        // lib.mapAttrs' (name: package: lib.nameValuePair "package-${name}" package) packages.${system}
        // lib.mapAttrs' (name: shell: lib.nameValuePair "devshell-${name}" shell) devShells.${system}
      );

      formatter = eachSystem (system: treefmtEval.${system}.config.build.wrapper);
    };
}
