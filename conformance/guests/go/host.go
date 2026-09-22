//go:build bridge_host

package main

import bridge "github.com/wasm-fmt/bridge/fdk-go"

type hostFormatter struct{ conformanceFormatter }

func (hostFormatter) Format(source []byte, filename *string, ranges []bridge.TextRange, config conformanceConfig, host *bridge.Host) bridge.FormatResult {
	if filename == nil || *filename != "embedded" {
		return (conformanceFormatter{}).Format(source, filename, ranges, config)
	}
	if string(source) == "__trap" {
		panic("requested child trap")
	}
	result, err := host.FormatEmbedded(bridge.EmbeddedRequest{Source: string(source), Filename: "embedded.py", LineWidth: 60})
	if err != nil {
		return bridge.FormatError(err)
	}
	if !result.Handled {
		return bridge.Unchanged()
	}
	return bridge.FullUpdate([]byte(result.Text))
}

func init() { engine = bridge.NewHostEngine[conformanceConfig](hostFormatter{}) }
