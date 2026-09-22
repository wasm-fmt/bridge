//go:build !tinygo.wasm || !wasm_unknown

package bridge

import "errors"

func exchangeEmbedded(_ []byte) (EmbeddedResult, error) {
	return EmbeddedResult{}, errors.New("embedded host imports require a TinyGo wasm guest")
}
