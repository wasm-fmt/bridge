# wasm-fmt Bridge

Bridge is the ABI and shared implementation space for wasm-fmt host runtimes and formatter development kits.

## Release status and support

The packages are unpublished and retain the development version **0.0.0**.
The first release version has not been selected.
Package versions are separate from the **Bridge ABI v1** wire version.
See [CHANGELOG.md](CHANGELOG.md) and [RELEASING.md](RELEASING.md).

| Component | Supported baseline |
| --- | --- |
| Rust FDK and macros | Rust 1.98.1, edition 2024 |
| Go FDK | Go 1.27.1; Wasm builds use TinyGo 0.42.0 with conservative GC |
| JavaScript runtime and bindgen | Node.js 26.10.0 |

These baselines are the versions exercised by the repository's contract suite.
Older toolchains are not part of the initial support contract. The runtime
also uses standard WebAssembly and Web APIs for browser integrations, but
browser, Bun, and Deno version support has not yet been qualified. Bindgen
runs under Node.js; generating a Web/Vite entry point does not by itself
certify a browser support matrix.

## License

Bridge is available under either the [MIT license](LICENSE-MIT) or the
[Apache License 2.0](LICENSE-APACHE), at your option. Each published package
includes both license texts.

## Layout

```text
crates/
  wasm-fmt-fdk/
    macros/    Rust proc macros used by the FDK
fdk-go/          Go formatter development kit
runtime/         JavaScript host runtime
bindgen/         Build-time JavaScript bindings generator
spec/            Bridge ABI specification and fixtures
conformance/     Cross-language ABI conformance tests
```

## Tests

Run the complete repository contract suite with `mise run test`. Test ownership
is intentionally narrow: conformance owns observable cross-language ABI
behavior, the JavaScript runtime owns validation of untrusted host and guest
data, each FDK owns language-specific safety constraints, and bindgen owns the
behavior and filesystem safety of generated packages. Private helper behavior
and behavior already owned by another layer should not receive duplicate tests.

## Version management

Use `mise run version:check` to check package version consistency, and
`mise run version <version|major|minor|patch> --dry-run` to preview an update.
Remove `--dry-run` to apply it. See [RELEASING.md](RELEASING.md) for the
coordinated Rust/npm/Go release procedure.

## Local consumers

The formatter migrations currently use sibling path dependencies while the packages are under development:

- `shfmt` and `gofmt` replace `github.com/wasm-fmt/bridge/fdk-go` with `../bridge/fdk-go`.
- `markdown`, `ruff_fmt`, `mago_fmt`, `wgslfmt`, `yamlfmt`, `taplo_fmt`, `sql_fmt`, and `lua_fmt` depend on `wasm-fmt-fdk` at `../bridge/crates/wasm-fmt-fdk`.
- each formatter's JavaScript package depends on `@wasm-fmt/runtime` from `file:../bridge/runtime`.

These local paths are for validation only and must be replaced with released versions before publishing the formatter packages.

## JavaScript bindings

[`@wasm-fmt/bindgen`](./bindgen/) generates the mechanical Node, ESM,
bundler, Web, and Vite entry points around a compiled Bridge guest. A
formatter keeps its configuration encoding and public API in one adapter:

```js
// bindings/formatter_binding.js
// @ts-check


/** @typedef {typeof import("./example_fmt.d.ts")} PublicApi */

/** @type {import("@wasm-fmt/runtime").FormatterAdapter<PublicApi>} */
const adapter = {
	create(wasm, host) {
		const runtime = host.createRuntime(wasm, { encodeConfig });
		/** @type {PublicApi} */
		const api = {
			format: runtime.format.bind(runtime),
			createConfig(config) {
				return /** @type {import("./example_fmt.d.ts").ConfigHandle} */ (runtime.createConfig(config));
			},
			releaseConfig: runtime.releaseConfig.bind(runtime),
		};
		return api;
	},
};

export default adapter;
```

The build-time descriptor selects files and targets; the adapter defines the
public functions:

```js
// bridge.bindings.mjs
import { defineBindings } from "@wasm-fmt/bindgen";

export default defineBindings({
	name: "example_fmt",
	wasm: "target/wasm32-unknown-unknown/release/example_fmt.wasm",
	wasmFile: "example_fmt_bg.wasm",
	adapter: "bindings/formatter_binding.js",
	types: { main: "bindings/example_fmt.d.ts" },
	outDir: "pkg",
	clean: true,
});
```

`defineBindings()` only provides build-time type inference.
`wasm-fmt-bindgen` inspects the Wasm module, creates a disposable instance, and
calls the typed default adapter once to infer its enumerable own function
exports. It then copies package assets and emits static imports and direct
function references. Generated runtime code does not evaluate descriptors,
discover API keys, look up endpoint names, use a `Proxy`, or add forwarding
wrappers on the formatting hot path. Configuration remains opaque to both
bindgen and the shared host runtime.

Bridge v1 covers whole-file, range, and synchronous embedded formatting. A
host context can compose independently initialized language formatters; see
[runtime composition](runtime/README.md#composing-formatters).

## Configuration encoding

Bridge treats formatter configuration as opaque bytes. Host adapters choose how to encode user-facing values, and formatter-owned config types choose how to decode those bytes. The ABI, host runtime, Rust FDK, and Go FDK do not prescribe JSON or Serde.

In Rust, a custom formatter config is marked and implements `bridge::Config`
explicitly:

```rust
#[bridge::config]
#[derive(Default)]
struct Options {
    // ...
}

impl bridge::Config for Options {
    fn decode(bytes: &[u8]) -> bridge::Result<Self> {
        // Formatter-owned decoding.
    }
}
```

`#[bridge::config]` declares the guest's one concrete config type and emits its
typed registered-config store and lifecycle exports. It never derives decoding
or assumes Serde. The FDK includes encoding-neutral implementations for `()`,
`String`, and `Vec<u8>`; select one with, for example,
`bridge::guest!(config = String)`. A formatter may use Serde inside its own
implementation, but the FDK does not enable or invoke Serde implicitly. A Rust
guest with no config calls `bridge::guest!()` once.

## Rust formatter endpoints

Each `#[bridge::formatter]` function is an independent formatter endpoint.
The Rust function name determines the Wasm export name, while parameter names
and types determine the request fields the endpoint accepts:

```rust
#[bridge::formatter]
fn format(
    config: &Options,
    source: &str,
    filename: Option<&str>,
) -> Result<String, String> {
    // ...
}
```

The example above exports `wasm_fmt_format`. Additional annotated functions may
coexist in the same guest:

```rust
use std::ops::Range;

#[bridge::formatter]
fn format_range(
    source: &str,
    ranges: &[Range<u32>],
    config: &Options,
) -> Result<bridge::FormatResult, String> {
    // ...
}
```

This function exports `wasm_fmt_format_range`. Shared allocation, result,
error, and configuration state is emitted once by the FDK rather than once per
endpoint.

- `source: &str` is required.
- `host: &bridge::Host<'_>` supplies call-scoped embedded formatting access
  when the `host-formatting` feature is enabled.
- `filename: Option<&str>` is optional.
- `config: &T` uses `T::default()` when config is absent.
- `config: Option<&T>` preserves absent as `None`.
- `ranges: &[Range<u32>]` requires a range request.
- `ranges: Option<&[Range<u32>]>` accepts both whole-file and range requests.

A function without a `config` parameter does not support configuration; Bridge
rejects inline and registered configuration for that endpoint. Both accepted
config signatures use the same underlying `T: bridge::Config`;
`config: &T` additionally requires `T: Default`.

A function without a `ranges` parameter rejects range requests. A missing
`ranges` field and a present empty range list remain distinct:

```text
None       whole-file request
Some(&[]) explicit empty range request
Some(...) range request
```

All configured endpoints in one guest use the one type declared by
`#[bridge::config]`. The attribute may live beside a config type in a submodule,
but it may appear only once in a final guest. A second declaration conflicts on
the fixed config lifecycle exports; an endpoint using an undeclared type fails
the generated `GuestConfig` bound. The typed registry decodes configuration
during registration and stores the concrete value directly, without `Any`,
`TypeId`, or downcasting.

## Format results

The guest chooses one of four result variants: unchanged, full update, partial
update, or error. Bridge does not infer unchanged by comparing strings; an
ordinary Rust `String` or `Result<String, E>` is always a full update.

Rust formatters that need explicit control can return `bridge::FormatResult`.
Partial updates use standard-library byte ranges:

```rust
use std::ops::Range;

bridge::FormatResult::PartialUpdate(vec![bridge::TextEdit {
    range: Range { start: 0, end: 4 },
    text: "text".to_owned(),
}])
```

Ranges refer to UTF-8 byte offsets in the original source. The FDK validates
ordering, overlap, bounds, and character boundaries before encoding edits.
Partial updates are an output representation for any format request; they are
not range-format requests.

## Instance constraints

Bridge v1 uses one owner per Wasm instance, unshared wasm32 memory, restricted
host imports, and serial synchronous calls without reentrancy. Configuration is
validated eagerly, registered once per live id, and borrowed read-only while
formatting. Rust configs do not need `Clone`. Request data is valid only for
the current call. A trap or malformed guest response retires the instance;
normal formatter errors remain recoverable. See the [ownership contract](spec/v1.md#instance-and-call-ownership).
