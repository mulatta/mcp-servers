{
  inputs,
  workspaceRoot,
}:
let
  inherit (inputs.nixpkgs) lib;

  workspace = inputs.uv2nix.lib.workspace.loadWorkspace { inherit workspaceRoot; };

  pythonOverlay = workspace.mkPyprojectOverlay { sourcePreference = "wheel"; };
in
{
  inherit workspace;

  mkPythonSet =
    pkgs:
    (pkgs.callPackage inputs.pyproject-nix.build.packages {
      python = pkgs.python3;
    }).overrideScope
      (
        lib.composeManyExtensions [
          inputs.pyproject-build-systems.overlays.wheel
          pythonOverlay
        ]
      );
}
