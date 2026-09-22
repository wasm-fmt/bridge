package main

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	bridge "github.com/wasm-fmt/bridge/fdk-go"
)

var engine = bridge.NewConfigRangeEngine[conformanceConfig](conformanceFormatter{})

type conformanceFormatter struct{}

type conformanceConfig struct {
	prefix string
}

func (conformanceFormatter) DecodeConfig(config []byte) (conformanceConfig, error) {
	if !utf8.Valid(config) {
		return conformanceConfig{}, errors.New("config must be valid UTF-8")
	}
	return conformanceConfig{prefix: string(config)}, nil
}

func (conformanceFormatter) DefaultConfig() conformanceConfig {
	return conformanceConfig{}
}

func (conformanceFormatter) Format(
	source []byte,
	filename *string,
	ranges []bridge.TextRange,
	config conformanceConfig,
) bridge.FormatResult {
	if ranges != nil {
		if filename != nil && *filename == "range-partial" {
			return partial(edit(0, 1, "X"))
		}
		return bridge.FullUpdate([]byte(config.prefix + describeRanges(ranges)))
	}

	mode := ""
	if filename != nil {
		mode = *filename
	}

	switch mode {
	case "config":
		return bridge.FullUpdate([]byte(config.prefix + string(source)))
	case "replacement":
		return partial(edit(6, 10, "BETA"))
	case "insertion":
		return partial(edit(2, 2, "XY"))
	case "deletion":
		return partial(edit(1, 3, ""))
	case "multiple":
		return partial(
			edit(0, 1, "A"),
			edit(2, 4, "CD"),
			edit(6, 6, "!"),
		)
	case "same-position-insertions":
		return partial(edit(1, 1, "X"), edit(1, 1, "Y"))
	case "empty":
		return partial()
	case "unicode":
		return partial(edit(1, 5, "猫"))
	case "invalid-unicode-boundary":
		return partial(edit(2, 5, "x"))
	case "unchanged":
		return bridge.Unchanged()
	case "full":
		return bridge.FullUpdate([]byte(strings.ToUpper(string(source))))
	case "identical-full":
		return bridge.FullUpdate(source)
	case "error":
		return bridge.FormatError(fmt.Errorf("requested conformance error"))
	default:
		return bridge.FormatError(fmt.Errorf("unknown conformance mode %q", mode))
	}
}

func describeRanges(ranges []bridge.TextRange) string {
	switch len(ranges) {
	case 0:
		return "ranges:empty"
	case 1:
		textRange := ranges[0]
		return fmt.Sprintf("ranges:one:%d-%d", textRange.Start, textRange.End)
	default:
		descriptions := make([]string, len(ranges))
		for index, textRange := range ranges {
			descriptions[index] = fmt.Sprintf("%d-%d", textRange.Start, textRange.End)
		}
		return "ranges:many:" + strings.Join(descriptions, ",")
	}
}

func partial(edits ...bridge.TextEdit) bridge.FormatResult {
	return bridge.PartialUpdate(edits)
}

func edit(start uint32, end uint32, text string) bridge.TextEdit {
	return bridge.TextEdit{
		Range: bridge.TextRange{Start: start, End: end},
		Text:  text,
	}
}

//go:wasmexport wasm_fmt_abi_version
func WasmFmtABIVersion() uint32 {
	return bridge.ABIVersion
}

//go:wasmexport wasm_fmt_alloc
func WasmFmtAlloc(size uint32) uint32 {
	return engine.Alloc(size)
}

//go:wasmexport wasm_fmt_reset
func WasmFmtReset() {
	engine.Reset()
}

//go:wasmexport wasm_fmt_register_config
func WasmFmtRegisterConfig(id uint32, pointer uint32, length uint32) uint32 {
	return engine.RegisterConfig(id, pointer, length)
}

//go:wasmexport wasm_fmt_release_config
func WasmFmtReleaseConfig(id uint32) {
	engine.ReleaseConfig(id)
}

//go:wasmexport wasm_fmt_format
func WasmFmtFormat(pointer uint32, length uint32) uint32 {
	return engine.Format(pointer, length)
}

//go:wasmexport wasm_fmt_output
func WasmFmtOutput() uint32 {
	return engine.Output()
}

//go:wasmexport wasm_fmt_error
func WasmFmtError() uint32 {
	return engine.Error()
}

func main() {}
