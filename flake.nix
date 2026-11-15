{
  # Dev shell with the tools the scripts want from PATH: esbuild (bundles the app for
  # 2020 TVs) and node (tools/devserver.mjs, tools/remote.mjs). Samsung's Tizen Studio
  # is proprietary and Intel-only, so scripts/setup.sh installs that one.
  #   nix develop -c ./scripts/deploy.sh
  description = "SamSUCKS: a Plex client for Samsung TVs";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ esbuild nodejs jq curl ];
        };
      });
    };
}
