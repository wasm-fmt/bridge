# Releasing Bridge

Publishing is a separate maintainer action; running the checks below does not
publish packages.

## Versions and compatibility

Use one coordinated package version across:

- `wasm-fmt-fdk` and `wasm-fmt-fdk-macros`: the root workspace version.
- `@wasm-fmt/runtime` and `@wasm-fmt/bindgen`: each `package.json` version.
- Go FDK: the tag `fdk-go/vX.Y.Z` (Go modules do not declare their own version
  in `go.mod`). The conformance Go requirement must match.

Keep the FDK's exact macro dependency synchronized with the macro release:
generated code uses the FDK's private interface. Keep both Cargo lockfiles in
sync. Private test-fixture package versions are not release versions.

Package versions and the wire ABI version are independent. A package release
does not change `wasm_fmt_abi_version()`. Record breaking package API changes
in the changelog; incompatible wire changes require an explicit ABI revision.

## Update versions

Use the repository task instead of running `npm version` in an individual
package:

```sh
mise run version:check
mise run version 0.1.0 --dry-run
mise run version 0.1.0
# Subsequent stable releases:
mise run version patch
mise run version minor
mise run version major
# Prereleases use an explicit version:
mise run version 0.2.0-rc.1
```

These are alternative examples, not a sequence to run. The version task updates
the workspace version, both public npm packages, bindgen's exact runtime dependency, the exact macro dependency,
the Go conformance requirement, and local package records in both Cargo
lockfiles. It preserves external dependency resolutions and private fixture
versions. The Rust conformance guest inherits the workspace version; the private
npm conformance package keeps its own version.

All version locations are checked before writing any files. An existing mismatch
is an error to resolve, rather than silently choosing one version. `--dry-run`
performs the same checks without writes. `version:check` also runs in the test
suite and CI. The task does not commit, tag, push, or publish.

Accepted explicit versions use `X.Y.Z` or `X.Y.Z-prerelease`, without a leading
`v` or build metadata. For a prerelease's successor, specify the version explicitly.
Coordinated major versions 2 and above require a separate Go module/import-path
migration and are rejected by this task until that design is updated.

Review the changelog and release-status paragraphs in the READMEs separately:
changing a number does not make a package published. When actually publishing,
move the relevant notes under a version/date heading, retain an `Unreleased`
section, and update installation examples and release status. For npm prereleases,
use an explicit non-`latest` distribution tag (for example `--tag next`).

## Prepare and check

1. Run `mise run version <version>` and review the diff. Run
   `mise run version:check` to verify the synchronized versions.
2. Confirm the support baselines, MIT OR Apache-2.0 metadata, and both license
   texts in every package. Keep the toolchain pins and documented baselines
   aligned. Rust minimum versions are inherited by package manifests.
3. Run `mise run test`, `cargo clippy --workspace --all-targets -- -D warnings`,
   and `cargo fmt --all -- --check`.
4. Run `mise run package:check`. It validates both Rust packages together with
   `cargo publish --dry-run --locked --all-features -p wasm-fmt-fdk-macros -p wasm-fmt-fdk`,
   then checks npm package contents. Cargo uses a temporary local registry for
   the macro dependency, so both crates can be verified before either is published.
5. From each of `runtime/` and `bindgen/`, run `npm pack --dry-run` and verify
   that the declarations, JavaScript, README, and both licenses are included.
   Inspect the packed `package.json` for author, repository (including its
   monorepo directory), homepage, and issue tracker metadata; a successful dry
   run does not establish that these optional fields are complete.
6. Review the Go module's README, `go.mod`, package documentation, and both
   license files within `fdk-go/`. Do not rely on differently named licenses
   outside the module being copied into its distribution.
7. Commit the release state and push it to the repository so source and
   documentation links resolve. Record the actual release date in the
   changelog when publishing, not while preparing a release.

## Publish order

Use one reviewed release commit for the package set. After the maintainer
chooses to publish:

1. Publish `wasm-fmt-fdk-macros`; wait until its version can be resolved from
   crates.io, then dry-run and publish `wasm-fmt-fdk`.
2. Publish `@wasm-fmt/runtime`, then `@wasm-fmt/bindgen`, with public access.
   Bindgen depends on the matching runtime for build-time instantiation.
   Generated formatter packages must also declare their own runtime dependency.
3. Create and push `fdk-go/vX.Y.Z` at the release commit for the Go module.
   A root `vX.Y.Z` tag may identify the coordinated repository release but
   does not substitute for the Go subdirectory tag.
4. Verify installs in fresh consumer projects using registry versions, and
   publish release notes linked to the commit and changelog.

Before releasing downstream formatters, replace development `path`, `file:`,
and Go `replace` dependencies with these released packages. A conformance-only
local `replace` remains appropriate inside this repository.

## Automated tag releases

The release commit contains only coordinated version updates on top of code
that has already passed CI. Complete code and changelog changes beforehand.
The release workflow relies on this convention and does not rerun the test suite.

Pushing a root `vX.Y.Z` tag triggers `.github/workflows/release.yml`:

1. Check synchronized package versions and lockfiles. The tag must match the
   coordinated package version.
2. Publish the macro crate, then the FDK. Cargo waits for the macro publication
   to become available before the next command runs.
3. Publish the npm runtime, then bindgen. Stable versions use `latest`;
   prereleases use `next` and become GitHub prereleases.
4. Push the Go submodule tag at the same commit, then create a GitHub Release
   with automatically generated notes.

All publication commands live in the workflow YAML. There is no custom release
script or registry recovery layer. Push one release tag at a time. Use GitHub's
**Re-run failed jobs** for transient failures; do not rerun successful publishing
jobs. Each package has its own job, so an FDK failure does not rerun the macro
publication. If a registry accepted an upload but its job failed afterward,
verify that publication and complete the remaining release steps manually.
Published versions are immutable; do not move the tag or change package contents
to retry a partial release.

### One-time setup

Configure each crate and npm package for trusted publishing from
`wasm-fmt/bridge`, workflow `release.yml`, leaving the environment field empty.
No GitHub environment is required. If an existing trusted publisher specifies
`release`, remove that environment restriction as well. For npm, allow direct
`npm publish`. GitHub tag rules must allow the
workflow to push `fdk-go/v*` tags. New packages that require an initial manual
publication must be bootstrapped before enabling this normal release workflow.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[Cargo authentication](https://github.com/rust-lang/crates-io-auth-action).

### Release commands

```sh
mise run version 0.1.0
# Commit the version-only change on top of the tested main revision.
git tag -a v0.1.0 -m "Release 0.1.0"
git push origin v0.1.0
```

The tag push publishes packages. Do not create a GitHub Release or push a separate
Go tag beforehand. `mise run check`, `mise run test`, and `mise run package:check`
run the checks locally without publishing.
