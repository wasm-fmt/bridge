// Package bridge implements the formatter side of the wasm-fmt Bridge ABI v1.
//
// An Engine owns one synchronous, non-reentrant guest instance. It manages
// single-use input allocations, validated results, and eagerly decoded,
// read-only registered configurations. TinyGo Wasm builds must enable
// conservative garbage collection for long-lived instances.
package bridge
