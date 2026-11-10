{
  pkgs,
  pythonSet,
  workspace,
}:
let
  inherit (pkgs) lib;

  editablePythonSet = pythonSet.overrideScope (
    lib.composeManyExtensions [
      (workspace.mkEditablePyprojectOverlay { root = "$REPO_ROOT"; })
      (final: prev: {
        linkedin-mcp = prev.linkedin-mcp.overrideAttrs (old: {
          # Hatchling requires editables only when building a PEP 660 wheel.
          nativeBuildInputs =
            (old.nativeBuildInputs or [ ])
            ++ final.resolveBuildSystem {
              editables = [ ];
            };
        });
      })
    ]
  );
  virtualenv = editablePythonSet.mkVirtualEnv "mcp-servers-dev" workspace.deps.all;

  base = {
    packages = [
      pkgs.git
      pkgs.uv
    ];
    env = {
      UV_PYTHON = pythonSet.python.interpreter;
      UV_PYTHON_DOWNLOADS = "never";
    };
    shellHook = ''
      unset PYTHONPATH
      export REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    '';
  };

  mkDevShell =
    args:
    pkgs.mkShell (
      base
      // args
      // {
        packages = (args.packages or [ ]) ++ base.packages;
        env = base.env // (args.env or { });
        shellHook = base.shellHook + (args.shellHook or "");
      }
    );
in
{
  default = mkDevShell {
    packages = [ virtualenv ];
    env.UV_NO_SYNC = "1";
  };

  impure = mkDevShell {
    packages = [ pythonSet.python ];
    env = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      LD_LIBRARY_PATH = lib.makeLibraryPath [
        pkgs.stdenv.cc.cc.lib
        pkgs.zlib
      ];
    };
    shellHook = ''
      if [ ! -x .venv/bin/python ] || [ uv.lock -nt .venv/pyvenv.cfg ]; then
        uv sync --frozen --all-packages
      fi
      . .venv/bin/activate
    '';
  };
}
