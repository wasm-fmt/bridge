//go:build tinygo.wasm && wasm_unknown

package bridge

import (
	"errors"
	"runtime"
	"unicode/utf8"
	"unsafe"
)

//go:wasmimport wasm_fmt_host format_embedded
func hostFormatEmbedded(ptr unsafe.Pointer, length uint32) uint32

//go:wasmimport wasm_fmt_host embedded_result_len
func hostEmbeddedResultLen() uint32

//go:wasmimport wasm_fmt_host read_embedded_result
func hostReadEmbeddedResult(ptr unsafe.Pointer, length uint32)

func exchangeEmbedded(request []byte) (EmbeddedResult, error) {
	status := hostFormatEmbedded(unsafe.Pointer(unsafe.SliceData(request)), uint32(len(request)))
	runtime.KeepAlive(request)
	switch status {
	case 0:
		return EmbeddedResult{}, nil
	case 1, 3:
	default:
		panic("host returned invalid embedded format status")
	}
	length := hostEmbeddedResultLen()
	if uint64(length) > uint64(int(^uint(0)>>1)) {
		panic("embedded result exceeds address space")
	}
	bytes := make([]byte, int(length))
	var ptr unsafe.Pointer
	if length != 0 {
		ptr = unsafe.Pointer(unsafe.SliceData(bytes))
	}
	hostReadEmbeddedResult(ptr, length)
	runtime.KeepAlive(bytes)
	if !utf8.Valid(bytes) {
		panic("host embedded result must be UTF-8")
	}
	text := string(bytes)
	if status == 3 {
		return EmbeddedResult{}, errors.New(text)
	}
	return EmbeddedResult{Text: text, Handled: true}, nil
}
