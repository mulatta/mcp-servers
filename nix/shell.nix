{ pkgs }:
let
  python = pkgs.python3.withPackages (ps: [
    ps.mcp
    ps.mypy
    ps.pytest
    ps.pytest-asyncio
  ]);
in
{
  default = pkgs.mkShell {
    packages = [
      python
      pkgs.git
      pkgs.ruff
    ];
  };
}
