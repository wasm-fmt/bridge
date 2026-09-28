# Changelog

## Unreleased

## 0.0.1 - 2026-09-29

- Declare Clippy in the Rust toolchain components so checks also run on fresh
  CI runners.
- Correct the published Rust/npm package status and document Go module
  installation and tag naming.

## 0.0.0 - 2026-09-28

Initial publication of the Rust FDK, macros, JavaScript runtime, and bindgen.
The Go FDK source is included in the repository, but no Go module version tag
was published for this release.

Bridge ABI v1 functionality:

- Rust FDK and procedural macros with typed, borrowed registered configurations.
- Go FDK for TinyGo Wasm guests with explicit configuration and range capabilities.
- JavaScript runtime for whole-file and range formatting, configuration handles,
  and unchanged, full-update, partial-update, and error responses.
- Build-time generation of Node, ESM, bundler, Web, and Vite entry points around
  formatter-owned adapters, plus independent instance factories for recovery.
- Exact ABI import/export signature checks and collision-free public JS exports.
- Unsigned Wasm pointer handling across the full wasm32 address range.
- Optional synchronous embedded-formatting imports, call-scoped Rust/Go host
  access, and a JavaScript formatter context for filename-based dispatch.
- Cross-language tests for wire contracts, ownership, and repeated instance use.

Guests use zero imports or the restricted embedded host group, unshared wasm32
memory, one host owner, synchronous
non-reentrant calls, and single-use input allocations. Traps and malformed ABI
responses retire the instance. Registered configuration is validated eagerly;
live ids cannot be overwritten. Formatter metadata remains outside ABI v1.

Supported baselines: Rust 1.98.1, Go 1.27.1, TinyGo 0.42.0, and Node.js 26.10.0.
Go Wasm builds require conservative GC. Browser/Bun/Deno versions have not yet
been qualified. All packages are licensed under MIT OR Apache-2.0.
