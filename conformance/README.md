# Conformance

This suite builds real Rust and Go WebAssembly guests against their local
Bridge FDKs, then runs both through the same JavaScript host runtime. It covers
full and partial updates, range requests, Rust's independent formatter
endpoints, Go's `format` fallback, opaque UTF-8 configuration through inline
and registered inputs, configuration release and validation, and the
import-free ABI surface. Separate Rust and Go host-enabled guests exercise
embedded transfers, UTF-8, skip/empty results, errors, cycles, context dispatch,
and bounded memory after allocator warmup. It also verifies exclusive allocation boundaries,
non-overwriting configuration registration, and bounded memory during repeated
formatting with live configuration handles. The Go guest explicitly enables
TinyGo conservative GC; the wasm-unknown target defaults to a leaking allocator.

```sh
mise install
npm test --prefix conformance
```

Generated Wasm modules are written to `artifacts/` and are not committed.
