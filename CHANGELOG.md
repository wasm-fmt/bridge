# Changelog

## Unreleased

Packages remain at the unpublished development version `0.0.0`; no first
release version or date has been selected.

Prepared functionality for the initial release of Bridge ABI v1:

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
