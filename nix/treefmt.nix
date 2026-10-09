{
  projectRootFile = "flake.nix";

  programs.deadnix.enable = true;
  programs.nixfmt.enable = true;

  programs.mdformat.enable = true;

  programs.shellcheck.enable = true;
  programs.shfmt.enable = true;

  programs.taplo.enable = true;
  programs.yamlfmt.enable = true;

  programs.ruff-check.enable = true;
  programs.ruff-format.enable = true;

  settings.formatter.deadnix.priority = 1;
  settings.formatter.nixfmt.priority = 3;

  settings.formatter.shellcheck.priority = 1;
  settings.formatter.shfmt.priority = 2;

  settings.formatter.ruff-check.priority = 1;
  settings.formatter.ruff-format.priority = 2;

  settings.global.excludes = [
    "**/.direnv/**"
  ];
}
