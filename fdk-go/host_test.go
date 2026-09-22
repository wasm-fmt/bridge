package bridge

import "testing"

type hostLifetimeFormatter struct{ saved Host }

func (f *hostLifetimeFormatter) DecodeConfig([]byte) (NoConfig, error) { return NoConfig{}, nil }
func (f *hostLifetimeFormatter) DefaultConfig() NoConfig               { return NoConfig{} }
func (f *hostLifetimeFormatter) Format(_ []byte, _ *string, _ []TextRange, _ NoConfig, h *Host) FormatResult {
	f.saved = *h
	if h.call == nil || !h.call.active {
		panic("host must be active during formatter body")
	}
	return Unchanged()
}
func TestCopiedHostExpiresAfterFormatterCall(t *testing.T) {
	formatter := &hostLifetimeFormatter{}
	adapter := hostFormatterAdapter[NoConfig]{formatter: formatter}
	adapter.format(nil, nil, nil, NoConfig{})
	if _, err := formatter.saved.FormatEmbedded(EmbeddedRequest{Source: "x", Filename: "x.py"}); err == nil {
		t.Fatal("copied host remained usable")
	}
	if _, err := (&Host{}).FormatEmbedded(EmbeddedRequest{}); err == nil {
		t.Fatal("zero host is usable")
	}
}
