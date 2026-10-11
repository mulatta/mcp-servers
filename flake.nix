{
  description = "MCP servers for personal use.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
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
    in
    {
      checks = eachSystem (system: {
        formatting = treefmtEval.${system}.config.build.check self;
      });

      formatter = eachSystem (system: treefmtEval.${system}.config.build.wrapper);

      devShells = eachSystem (
        system:
        import ./nix/shell.nix {
          pkgs = pkgsFor.${system};
        }
      );
    };
}
