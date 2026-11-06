{
  description = "Overleaf CLI: work with Overleaf projects from the command line";

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
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

          src = self;

          # Changes whenever package-lock.json changes. To recompute, set it to
          # pkgs.lib.fakeHash, run `nix build`, and copy the "got:" value.
          npmDepsHash = "sha256-iyYfEe5cXRrR5OtlWoRGYHW8LjoGGAfeQC/76L4vvsQ=";

          nodejs = pkgs.nodejs_24;

          # Build step compiles TypeScript
          buildPhase = ''
            npm run build
          '';

          # The package installs via npm global-style
          dontNpmInstall = false;

          meta = with pkgs.lib; {
            description = "Overleaf CLI: sync, compile, and manage Overleaf projects from the terminal";
            homepage = "https://github.com/aloth/olcli";
            license = licenses.mit;
            mainProgram = "olcli";
            maintainers = [];
            platforms = platforms.all;
          };
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_24 ];
        };
      }
    );
}
