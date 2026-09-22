# Host Runtime

## Installation and support

Requires Node.js **26.10.0** or newer when used with Node. Version **0.0.0**
is an unpublished development placeholder. After the first release:

```sh
npm install @wasm-fmt/runtime
```

The runtime uses standard WebAssembly and Web APIs. Browser, Bun, and Deno
version support has not yet been qualified; generated platform entry points
do not establish a tested platform support matrix.

JavaScript host runtime for loading and calling formatters that implement the wasm-fmt Bridge ABI.

Formatter packages provide their own configuration encoder and use this package for TLV requests,
WebAssembly memory access, status handling, partial-update edit application, and registered
configuration lifecycles.

Formatter-owned JavaScript adapters default-export a `FormatterAdapter<Api>`.
For checked JavaScript, annotate the local API object with the formatter's
handwritten public declaration module as well; this supplies contextual
parameter types and rejects missing or extra public values. Public declaration
modules used this way must expose functions only. Bindgen discovers the
enumerable own function properties at build time, and generated entries call
the adapter once per Wasm instance.

Formatter declarations can brand instance-local configuration handles without
declaring their own runtime value:

```ts
import type { ConfigHandle as BridgeConfigHandle } from "@wasm-fmt/runtime";
export type ConfigHandle = BridgeConfigHandle<"example_fmt">;
```

The runtime exposes three formatting entry points:

```js
const runtime = createBridgeRuntime(wasm, { encodeConfig });

runtime.format(source, filename, config);
runtime.formatRanges(source, [{ start: 0, end: 12 }], filename, config);
runtime.invoke("format_embedded", source, {
	filename,
	config,
	ranges: [{ start: 0, end: 12 }],
});
```

`format()` invokes the conventional `wasm_fmt_format` endpoint without a
`ranges` field. `formatRanges()` always sends a `ranges` field, including for an
empty array. It prefers `wasm_fmt_format_range` and falls back to
`wasm_fmt_format` when the specialized endpoint is absent.

`invoke()` calls any formatter endpoint exported as `wasm_fmt_<name>`. Endpoint
names are ASCII identifiers; Bridge core exports such as `alloc`, `reset`, and
`output` cannot be invoked through this API. All three methods return the final
string after handling unchanged, full-update, or partial-update results.

Ranges use half-open UTF-8 byte offsets into `source`. The runtime validates
every boundary before calling Wasm. Input ranges preserve wire order and may
overlap, repeat, or be out of order.

`createConfig()` eagerly validates and registers reusable configuration.
Invalid configuration throws without creating a handle. Handles are local to
one instance and must be released explicitly when no longer needed.

A runtime exclusively owns its guest. Creating a second runtime for the same
memory is rejected, including through an alias of the exports object. After
binding, do not call guest exports directly. Each adapter must create exactly
one runtime and bind all its public functions to it. Instances use unshared
memory, only the optional embedded host imports, and synchronous calls without
reentrancy into the same instance. Config encoders
must not call back into the runtime.

A trap, invalid guest memory response, unknown status, or malformed output
permanently retires the runtime and its config handles. No further guest
operations are attempted, including reset. To recover, use the generated
`<name>_factory.js` entry to create an independent replacement, or instantiate
and attach a new guest directly. Normal formatter errors (status `3`) and
preflight input errors leave
the instance usable. The allocation/write/call/read sequence is one transaction;
only a normal response is followed by reset.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

## Composing formatters

`createFormatterContext()` composes independently initialized packages. Each
registration supplies extensions (without a leading dot), exact file names, or
both, plus a synchronous function returning the formatted text. Matching is
case-insensitive; exact file names take precedence over extensions. Duplicate
registrations are rejected. Configuration stays in each registration's closure.

```js
import { createFormatterContext } from "@wasm-fmt/runtime";
import * as markdown from "@wasm-fmt/markdown";
import * as python from "@wasm-fmt/ruff_fmt";
import * as go from "@wasm-fmt/gofmt";

const context = createFormatterContext();
context.addFormatter({
  extensions: ["md", "markdown"],
  format: ({ source, onFormatEmbedded }) =>
    markdown.format(source, undefined, { onFormatEmbedded }),
});
context.addFormatter({
  extensions: ["py", "pyi"],
  format: ({ source, filename, lineWidth }) =>
    python.format(source, filename, lineWidth === undefined ? {} : { line_width: lineWidth }),
});
context.addFormatter({
  extensions: ["go"],
  format: ({ source }) => go.format(source),
});
const formatted = context.format({ filename: "README.md", source: document });
```

Initialize Web/Vite packages before registering/calling them. The context
supplies `onFormatEmbedded` automatically to registered functions; the
embedding formatter's adapter forwards it into its runtime invocation. Embedded
requests with no matching registration are skipped. Top-level requests without
a matching formatter throw. Cyclic dispatch and registration during formatting
are errors. Contexts and instance state are independent; callbacks are not
stored in a global registry. Direct package calls remain available.

For direct embedded formatting, pass `onFormatEmbedded` in `runtime.invoke`'s
options (Markdown exposes it as a separate third argument). It receives
`{source, filename, lineWidth?}` and returns a string, undefined to skip, or
throws. Promises are not supported. The handler applies any width hint to the
target formatter's options; context does not merge opaque configs or reinterpret
config handles.

## Instantiating a guest with host imports

```js
import { createBridgeHost } from "@wasm-fmt/runtime";
const host = createBridgeHost();
const instance = new WebAssembly.Instance(module, host.imports);
instance.exports._initialize?.();
const runtime = host.createRuntime(instance.exports, { encodeConfig });
```

Create one host per instance. `createRuntime` binds it exactly once. Imports
cannot be called during initialization or outside an active format endpoint.
Generated loaders perform this wiring automatically and pass the host to
`adapter.create(wasm, host)`. `createBridgeRuntime(wasm, options)` remains a
convenience for import-free guests. Do not attach that independent convenience
runtime to a guest instantiated with another host's imports.
