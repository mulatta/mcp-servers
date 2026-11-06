{ pkgs }:
{
  youtube = pkgs.mkShellNoCC {
    packages = [ pkgs.bun ];
  };
}
