{
  description = "Overleaf CLI – work with Overleaf projects from the command line";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "olcli";
          version = "0.7.0";

          src = self;

          npmDepsHash = "";  # Run: nix build .# 2>&1 | grep 'got:' to get the hash

          nodejs = pkgs.nodejs_22;

          # Build step compiles TypeScript
          buildPhase = ''
            npm run build
          '';

          # The package installs via npm global-style
          dontNpmInstall = false;

          meta = with pkgs.lib; {
            description = "Overleaf CLI – sync, compile, and manage Overleaf projects from the terminal";
            homepage = "https://github.com/aloth/olcli";
            license = licenses.mit;
            mainProgram = "olcli";
            maintainers = [];
            platforms = platforms.all;
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
        };
      }
    );
}
