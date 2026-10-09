{
  description = "MCP servers for personal use.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
    };
    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
    };
  };

  outputs =
    inputs@{
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

      project = import ./nix/python.nix {
        inherit inputs;
        workspaceRoot = ./.;
      };

      treefmtEval = eachSystem (system: treefmt-nix.lib.evalModule pkgsFor.${system} ./nix/treefmt.nix);
    in
    {
      checks = eachSystem (system: {
        formatting = treefmtEval.${system}.config.build.check self;
      });

      formatter = eachSystem (system: treefmtEval.${system}.config.build.wrapper);

      packages = eachSystem (
        system:
        let
          pythonSet = project.mkPythonSet pkgsFor.${system};
        in
        {
          default = pythonSet.mkVirtualEnv "PROJ_NAME-env" project.workspace.deps.default;
          full = pythonSet.mkVirtualEnv "PROJ_NAME-full-env" project.workspace.deps.all;
        }
      );

      devShells = eachSystem (
        system:
        import ./nix/shell.nix {
          pkgs = pkgsFor.${system};
          inherit (project) workspace;
          pythonSet = project.mkPythonSet pkgsFor.${system};
        }
      );
    };
}
