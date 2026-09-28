# wasm-fmt Bridge

Bridge provides a shared WebAssembly ABI, formatter development kits, and a
JavaScript host runtime for code formatters.

It supports whole-file, range, and synchronous embedded-language formatting.
Formatter configuration stays opaque to the ABI: each formatter defines its own
encoding and decoding. Package versions are independent of the **Bridge ABI v1**
wire version.

## Packages

| Package | Purpose |
| --- | --- |
| [wasm-fmt-fdk](crates/wasm-fmt-fdk/README.md) | Rust formatter development kit, including procedural macros |
| [Go FDK](fdk-go/README.md) | Go formatter development kit for TinyGo Wasm guests |
| [@wasm-fmt/runtime](runtime/README.md) | JavaScript host runtime and formatter composition |
| [@wasm-fmt/bindgen](bindgen/README.md) | JavaScript bindings generator for compiled formatters |

See each package's README for installation, usage, and supported toolchains.
The [ABI specification](spec/v1.md) defines the wire format and instance ownership
contract.

## Development

```sh
mise run check
mise run test
mise run package:check
```

See [RELEASING.md](RELEASING.md) for version management and publishing, and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
