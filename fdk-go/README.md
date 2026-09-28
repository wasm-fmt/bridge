# Go FDK

## Installation and support

Requires Go **1.27.1** or newer. The validated Wasm compiler is TinyGo
**0.42.0**, built with `-target=wasm-unknown -gc=conservative`.
Install the latest release with:

```sh
go get github.com/wasm-fmt/bridge/fdk-go@latest
```

This subdirectory module is released with the Git tag `fdk-go/vX.Y.Z`;
consumers use `@vX.Y.Z` in `go get`, without the tag's `fdk-go/` prefix.

Go formatter development kit for the wasm-fmt Bridge ABI.

The package name is `bridge`:

```go
import "github.com/wasm-fmt/bridge/fdk-go"
```

Formatters without configuration use `NewEngine` and implement `Formatter`:

```go
engine := bridge.NewEngine(formatter)

func (formatter) Format(source []byte, filename *string) bridge.FormatResult {
	path := ""
	if filename != nil {
		path = *filename
	}
	formatted, err := formatSource(source, path)
	return bridge.FromBytes(formatted, err)
}
```

Configurable formatters use `NewConfigEngine` and implement `ConfigFormatter[C]`:

```go
engine := bridge.NewConfigEngine[Options](formatter)

func (formatter) DefaultConfig() Options {
	return Options{/* formatter defaults */}
}
```

`DefaultConfig` is used only when the request omits both inline and registered
configuration. It is intentionally explicit: Bridge does not assume that Go's
zero value is the formatter's default, and it does not prescribe a config
encoding.

Range-aware formatters use `NewRangeEngine` and implement `RangeFormatter`:

```go
engine := bridge.NewRangeEngine(formatter)

func (formatter) Format(
	source []byte,
	filename *string,
	ranges []bridge.TextRange,
) bridge.FormatResult {
	if ranges == nil {
		return formatWholeFile(source)
	}
	return formatRanges(source, ranges)
}
```

Formatters supporting both configuration and ranges use
`NewConfigRangeEngine[C]` and implement `ConfigRangeFormatter[C]`.

The four constructors declare the formatter's capabilities explicitly:

| Constructor | Configuration | Ranges |
| --- | --- | --- |
| `NewEngine` | No | No |
| `NewRangeEngine` | No | Yes |
| `NewConfigEngine[C]` | Yes | No |
| `NewConfigRangeEngine[C]` | Yes | Yes |

Sending a ranges field to an engine without range support is an error. For a
range-aware formatter, `nil` means the request omitted ranges and therefore
requests whole-file formatting. A non-nil empty slice represents an explicitly
present empty ranges list.

Input ranges use half-open UTF-8 byte offsets into the original source. The FDK
validates each range's `start <= end` relation, bounds, and UTF-8 boundaries.
It otherwise preserves the wire order and permits overlapping, repeated, and
unordered ranges.

Formatters return one of four explicit results:

- `bridge.Unchanged()`
- `bridge.FullUpdate(output)`
- `bridge.PartialUpdate(edits)`
- `bridge.FormatError(err)`

`bridge.FromBytes(output, err)` adapts the conventional `([]byte, error)`
result as a full update or error. It does not compare or normalize output;
return `bridge.Unchanged()` explicitly when appropriate. Partial edits use
UTF-8 byte offsets into the original source and must be forward ordered and
non-overlapping.

The optional filename is `nil` when the request omits the field. A non-nil
pointer to `""` represents a present-but-empty filename.

Each engine belongs to one serial, non-reentrant guest instance. Exported
operations must use the complete current `Alloc` buffer; arbitrary pointers
and subranges are invalid. A trap invalidates the instance permanently.
Registration eagerly decodes configuration and rejects already-live ids.
Formatter methods must treat configuration as read-only, including slices,
maps, and pointers stored inside it. Request inputs must not escape the call.

Build TinyGo guests with `-target=wasm-unknown -gc=conservative`. The target's
default `leaking` allocator never reclaims memory, so it is unsuitable for a
reusable Bridge instance. Reset drops transient roots; garbage collection
reclaims them without requiring linear memory to shrink.

## License

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

## Embedded formatting

`NewHostEngine[C]` accepts a `HostFormatter[C]`, with config decoding/defaults
and `Format(source, filename, ranges, config, host *Host)`. It supports config
and range fields; reject non-nil ranges explicitly if the formatter does not
implement range formatting. `host.FormatEmbedded(EmbeddedRequest{Source: text,
Filename: "embedded.py", LineWidth: 80})` returns `(EmbeddedResult, error)`.
`Handled` distinguishes no replacement from a successful empty `Text`.
LineWidth zero omits the hint. The Host expires when Format returns, including
copies of the handle. DecodeConfig does not receive it.

The TinyGo wasm-unknown implementation supplies the optional import group.
Unused host support is removed from ordinary guest binaries. Native builds
return an unsupported-target error from this operation. Source/config and
response storage remain independent; callbacks are synchronous.
