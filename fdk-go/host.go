package bridge

import (
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

// EmbeddedRequest describes source under a virtual filename. LineWidth zero
// means no width hint; a positive value is mapped to target options by the host.
type EmbeddedRequest struct {
	Source    string
	Filename  string
	LineWidth uint32
}

// EmbeddedResult distinguishes an empty replacement from no replacement.
type EmbeddedResult struct {
	Text    string
	Handled bool
}

// Host is valid only during the formatter call that receives it. Its zero value
// and any retained handle are unusable. Calls must remain synchronous.
type Host struct{ call *hostCall }

type hostCall struct{ active bool }

func (h *Host) FormatEmbedded(request EmbeddedRequest) (EmbeddedResult, error) {
	if h == nil || h.call == nil || !h.call.active {
		return EmbeddedResult{}, errors.New("embedded host is outside its formatter call")
	}
	if request.Filename == "" || !utf8.ValidString(request.Filename) || !utf8.ValidString(request.Source) {
		return EmbeddedResult{}, errors.New("embedded request requires UTF-8 source and nonempty filename")
	}
	length := uint64(24) + uint64(len(request.Source)) + uint64(len(request.Filename))
	if request.LineWidth != 0 {
		length += 12
	}
	if length > uint64(^uint32(0)) || length > uint64(int(^uint(0)>>1)) {
		return EmbeddedResult{}, errors.New("embedded request exceeds address space")
	}
	bytes := make([]byte, 0, int(length))
	bytes = append(bytes, "WASM-EMB"...)
	bytes = appendEmbeddedField(bytes, 1, 1, []byte(request.Source))
	bytes = appendEmbeddedField(bytes, 2, 1, []byte(request.Filename))
	if request.LineWidth != 0 {
		width := binary.LittleEndian.AppendUint32(nil, request.LineWidth)
		bytes = appendEmbeddedField(bytes, 3, 0, width)
	}
	return exchangeEmbedded(bytes)
}

func appendEmbeddedField(bytes []byte, tag, flags uint16, value []byte) []byte {
	bytes = binary.LittleEndian.AppendUint16(bytes, tag)
	bytes = binary.LittleEndian.AppendUint16(bytes, flags)
	bytes = binary.LittleEndian.AppendUint32(bytes, uint32(len(value)))
	return append(bytes, value...)
}

// HostFormatter supports config and optional ranges, with call-scoped host access.
// A formatter not supporting ranges must explicitly reject a non-nil ranges slice.
type HostFormatter[C any] interface {
	DecodeConfig([]byte) (C, error)
	DefaultConfig() C
	Format(source []byte, filename *string, ranges []TextRange, config C, host *Host) FormatResult
}

type hostFormatterAdapter[C any] struct{ formatter HostFormatter[C] }

func (a hostFormatterAdapter[C]) supportsConfig() bool { return true }
func (a hostFormatterAdapter[C]) supportsRanges() bool { return true }
func (a hostFormatterAdapter[C]) decodeConfig(bytes []byte) (C, error) {
	return a.formatter.DecodeConfig(bytes)
}
func (a hostFormatterAdapter[C]) defaultConfig() C { return a.formatter.DefaultConfig() }
func (a hostFormatterAdapter[C]) format(source []byte, filename *string, ranges []TextRange, config C) FormatResult {
	call := &hostCall{active: true}
	host := &Host{call: call}
	defer func() { call.active = false }()
	return a.formatter.Format(source, filename, ranges, config, host)
}

func NewHostEngine[C any](formatter HostFormatter[C]) *Engine[C] {
	return &Engine[C]{formatter: hostFormatterAdapter[C]{formatter}, registeredConfig: make(map[uint32]C)}
}
