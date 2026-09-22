import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeHost, createFormatterContext } from "../src/index.js";
const encoder = new TextEncoder();

function request(fields = [[1, "hello"], [2, "embedded.py"]]) {
	const parts = [encoder.encode("WASM-EMB")];
	for (const [tag, value, flags = 0] of fields) {
		const bytes = typeof value === "string" ? encoder.encode(value) : value;
		const header = new Uint8Array(8);
		const view = new DataView(header.buffer);
		view.setUint16(0, tag, true);
		view.setUint16(2, flags, true);
		view.setUint32(4, bytes.length, true);
		parts.push(header, bytes);
	}
	return Buffer.concat(parts);
}
function fixture(operation) {
	const host = createBridgeHost();
	const wasm = {
		memory: new WebAssembly.Memory({ initial: 1 }),
		wasm_fmt_abi_version: () => 1,
		wasm_fmt_alloc: () => 8,
		wasm_fmt_reset: () => {},
		wasm_fmt_register_config: () => 1,
		wasm_fmt_release_config: () => {},
		wasm_fmt_format: () => operation(host.imports.wasm_fmt_host, wasm),
	};
	const runtime = host.createRuntime(wasm);
	return { host, runtime, wasm };
}
function send(imports, wasm, bytes = request()) {
	new Uint8Array(wasm.memory.buffer, 1024, bytes.length).set(bytes);
	return imports.format_embedded(1024, bytes.length);
}

for (
	const [label, operation] of [
		["outside allocation", (_imports, wasm) => 0],
		["result without request", (imports) => imports.embedded_result_len()],
		["unconsumed result", (imports, wasm) => {
			send(imports, wasm);
			return 0;
		}],
		["second request", (imports, wasm) => {
			send(imports, wasm);
			send(imports, wasm);
			return 0;
		}],
		["wrong result length", (imports, wasm) => {
			send(imports, wasm);
			imports.read_embedded_result(2048, 1);
			return 0;
		}],
		["out of bounds result", (imports, wasm) => {
			send(imports, wasm);
			imports.read_embedded_result(-1, 2);
			return 0;
		}],
		["caught protocol error", (imports) => {
			try {
				imports.embedded_result_len();
			} catch {}
			return 0;
		}],
	]
) {
	test(`embedded protocol retires instance: ${label}`, () => {
		const { host, runtime, wasm } = fixture(operation);
		if (label === "outside allocation") {
			wasm.wasm_fmt_alloc = () => {
				host.imports.wasm_fmt_host.embedded_result_len();
				return 8;
			};
		}
		assert.throws(() => runtime.invoke("format", "x", { onFormatEmbedded: () => "ok" }));
		assert.throws(() => runtime.format("x"), /unusable/);
	});
}

for (
	const fields of [
		[[1, "x"]],
		[[1, "x"], [2, ""]],
		[[1, "x"], [1, "y"], [2, "a.py"]],
		[[1, "x"], [2, "a.py", 2]],
		[[1, "x"], [2, "a.py"], [42, "x", 1]],
		[[1, new Uint8Array([255])], [2, "a.py"]],
		[[1, "x"], [2, "a.py"], [3, new Uint8Array(4)]],
	]
) {
	test("reject malformed embedded request before calling handler", () => {
		const { runtime } = fixture((imports, wasm) => send(imports, wasm, request(fields)));
		let called = false;
		assert.throws(() =>
			runtime.invoke("format", "x", {
				onFormatEmbedded: () => {
					called = true;
					return "x";
				},
			})
		);
		assert.equal(called, false);
		assert.throws(() => runtime.format("x"), /unusable/);
	});
}

test("result copy refreshes memory view and consumes pending state", () => {
	const { runtime } = fixture((imports, wasm) => {
		assert.equal(send(imports, wasm, request([[1, "x"], [2, "a.py"], [42, "future"]])), 1);
		assert.equal(imports.embedded_result_len(), 3);
		wasm.memory.grow(1);
		imports.read_embedded_result(65536, 3);
		assert.deepEqual([...new Uint8Array(wasm.memory.buffer, 65536, 3)], [231, 140, 171]);
		return 0;
	});
	assert.equal(runtime.invoke("format", "original", { onFormatEmbedded: () => "猫" }), "original");
	assert.equal(runtime.invoke("format", "again", { onFormatEmbedded: () => "猫" }), "again");
});

test("imports are forbidden during config registration and after attachment", () => {
	const { host, runtime } = fixture(() => 0);
	assert.throws(() => host.imports.wasm_fmt_host.format_embedded(0, 0), /active formatter/);
	assert.throws(() => runtime.format("x"), /unusable/);
});

test("context isolates registrations, matches names first, and rejects cycles", () => {
	const context = createFormatterContext();
	context.addFormatter({ extensions: ["PY"], format: ({ source }) => source.toUpperCase() });
	context.addFormatter({ fileNames: ["special.py"], format: () => "special" });
	context.addFormatter({
		extensions: ["md"],
		format: ({ source, onFormatEmbedded }) => onFormatEmbedded({ filename: "x.py", source }),
	});
	assert.equal(context.format({ filename: "X.MD", source: "abc" }), "ABC");
	assert.equal(context.format({ filename: "dir\\special.py", source: "abc" }), "special");
	assert.throws(() => context.addFormatter({ extensions: ["py"], format: () => "" }), /duplicate/);
	assert.throws(() => createFormatterContext().format({ filename: "x.py", source: "a" }), /no formatter/);
	context.addFormatter({
		extensions: ["loop"],
		format: ({ source, onFormatEmbedded }) => onFormatEmbedded({ filename: "x.loop", source }),
	});
	assert.throws(() => context.format({ filename: "x.loop", source: "x" }), /cyclic/);
	assert.equal(context.format({ filename: "x.py", source: "ok" }), "OK");
});
