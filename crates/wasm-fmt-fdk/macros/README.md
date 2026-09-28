# wasm-fmt FDK macros

## Installation and support

Requires Rust **1.98.1** or newer. Formatter authors should use
`wasm-fmt-fdk`, which selects the
matching macro version. The generated private FDK interface is not a
separately supported public API.

Procedural macro implementation for `wasm-fmt-fdk`. Formatter authors should
depend on `wasm-fmt-fdk`, which re-exports these macros through the `bridge`
crate API.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
