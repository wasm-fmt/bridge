# wasm-fmt FDK for Rust

## Installation and support

Requires Rust **1.98.1** or newer. The crate uses edition 2024.
Add the FDK from crates.io:

```sh
cargo add wasm-fmt-fdk --rename bridge
```

The FDK re-exports its matching macro crate; consumers do not need a separate
macro dependency.

The Rust FDK exports ordinary Rust functions through the Bridge ABI.

```rust
use std::ops::Range;

#[bridge::config]
#[derive(Default)]
struct Options {
    uppercase: bool,
}

impl bridge::Config for Options {
    fn decode(bytes: &[u8]) -> bridge::Result<Self> {
        // The formatter owns this encoding. Bridge does not assume serde,
        // JSON, or any other configuration representation.
        Ok(Self {
            uppercase: bytes == b"uppercase",
        })
    }
}

#[bridge::formatter]
fn format(source: &str, config: &Options) -> String {
    if config.uppercase {
        source.to_uppercase()
    } else {
        source.to_owned()
    }
}

#[bridge::formatter]
fn format_range(
    source: &str,
    ranges: &[Range<u32>],
    config: &Options,
) -> bridge::Result<String> {
    let _ = (ranges, config);
    Ok(source.to_owned())
}
```

Every configured endpoint in one guest uses the same concrete config type.
`#[bridge::config]` declares that type, emits its typed registered-config store,
and emits the config lifecycle exports. The type must still implement
`bridge::Config` explicitly; the attribute never chooses an encoding. A second
`#[bridge::config]` declaration emits the same fixed ABI exports and therefore
fails when the guest is built. An endpoint that names an unmarked config type
fails its generated `GuestConfig` trait bound at compile time.

The declaration may live in a submodule alongside the config type. Generic
config declarations are rejected because a Wasm guest must select one concrete
type. `()`, `String`, and `Vec<u8>` have built-in config implementations; select
one directly with `bridge::guest!(config = String)`. A guest with no config at
all declares `bridge::guest!()` once instead. Custom configured guests do not
also call `bridge::guest!`.

Use `config: &Options` when a missing config should supply
`Options::default()`. Use `config: Option<&Options>` when the endpoint needs to
distinguish an absent field from a present config; present empty bytes still
call `Options::decode(&[])`. Only the first form requires `Options: Default`.

Registered configuration is decoded by `Config::decode` during
`wasm_fmt_register_config` and stored directly as the declared concrete type.
Registration therefore returns status `3` immediately for invalid bytes.
Registering an already-live id is rejected; releasing the id drops its value.
The FDK does not use `Any`, `TypeId`, or downcasting.

Registered configurations are eagerly decoded and borrowed for each call;
`Config` does not require `Clone`. An already-live id cannot be overwritten.
Calls are synchronous, serial, and non-reentrant. Input borrows end with the
formatter call, and only the complete current allocation may be passed to a
guest export. A trap invalidates the instance permanently.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

## Embedded formatting

Enable the `host-formatting` feature and add `host: &bridge::Host<'_>` to a
formatter's parameters. It is supplied after input/config decoding and must not
escape that invocation. `host.format_embedded(bridge::EmbeddedRequest {
source, filename: "embedded.py", line_width: None })` returns
`Result<Option<String>, String>`: None means no replacement, while Some("")
is a successful empty replacement. Configuration decoders do not receive host
access. The helper uses independent owned buffers and never reenters the
instance's allocator export. Imports exist only in Wasm builds that use the
helper; native calls return an unsupported-target error. For native formatter
tests, inject a closure into the formatter's internal implementation.
