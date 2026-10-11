{ pkgs }:
let
  youtube = pkgs.mkShell {
    packages = [ pkgs.bun ];
  };
in
{
  inherit youtube;
  default = youtube;
}
