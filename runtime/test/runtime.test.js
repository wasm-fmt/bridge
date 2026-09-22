import assert from "node:assert/strict";
import { test } from "node:test";

import { createBridgeRuntime } from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("formats through a TLV request", () => {
	const fake = createFakeWasm();
	fake.output = "formatted";
	const runtime = createBridgeRuntime(fake.exports);

	assert.equal(runtime.format("source", "file.txt"), "formatted");
	assert.deepEqual(readFields(fake.lastRequest), [
		[1, encoder.encode("source")],
		[2, encoder.encode("file.txt")],
	]);
	assert.equal(fake.resetCount, 1);
});

test("invoke rejects unsafe, core, missing, and non-function endpoints", () => {
	const fake = createFakeWasm();
	const runtime = createBridgeRuntime(fake.exports);

	assert.throws(() => runtime.invoke("../format", "source"), /ASCII identifier/);
	assert.throws(() => runtime.invoke("alloc", "source"), /Bridge core export/);
	assert.throws(() => runtime.invoke("missing", "source"), /is not exported/);
	assert.throws(
		() => runtime.invoke("format", "source", null),
		/invocation options must be an object/,
	);

	fake.exports.wasm_fmt_not_a_function = 42;
	assert.throws(() => runtime.invoke("not_a_function", "source"), /is not exported/);
	assert.equal(fake.formatCallCount, 0);
	assert.equal(fake.resetCount, 0);
});

test("validates range structure and UTF-8 byte boundaries before calling wasm", async (t) => {
	const cases = [
		{
			name: "ranges is not an array",
			source: "source",
			ranges: {},
			error: /ranges must be an array/,
		},
		{
			name: "range is not an object",
			source: "source",
			ranges: [null],
			error: /ranges\[0\] must be an object/,
		},
		{
			name: "negative offset",
			source: "source",
			ranges: [{ start: -1, end: 1 }],
			error: /unsigned 32-bit integers/,
		},
		{
			name: "fractional offset",
			source: "source",
			ranges: [{ start: 0, end: 1.5 }],
			error: /unsigned 32-bit integers/,
		},
		{
			name: "offset above u32",
			source: "source",
			ranges: [{ start: 0, end: 0x1_0000_0000 }],
			error: /unsigned 32-bit integers/,
		},
		{
			name: "start after end",
			source: "source",
			ranges: [{ start: 2, end: 1 }],
			error: /start greater than end/,
		},
		{
			name: "range beyond source",
			source: "source",
			ranges: [{ start: 0, end: 7 }],
			error: /outside the source byte range/,
		},
		{
			name: "range start splits UTF-8",
			source: "a💩b",
			ranges: [{ start: 2, end: 5 }],
			error: /UTF-8 character boundaries/,
		},
		{
			name: "range end splits UTF-8",
			source: "a💩b",
			ranges: [{ start: 1, end: 4 }],
			error: /UTF-8 character boundaries/,
		},
	];

	for (const testCase of cases) {
		await t.test(testCase.name, () => {
			const fake = createFakeWasm();
			const runtime = createBridgeRuntime(fake.exports);

			assert.throws(
				() => runtime.formatRanges(testCase.source, testCase.ranges),
				testCase.error,
			);
			assert.equal(fake.formatCallCount, 0);
			assert.equal(fake.resetCount, 0);
		});
	}
});

test("rejects ill-formed UTF-16 source and filename before calling wasm", () => {
	const fake = createFakeWasm();
	const runtime = createBridgeRuntime(fake.exports);

	assert.throws(() => runtime.format("\ud800"), /source must be well-formed UTF-16/);
	assert.throws(() => runtime.format("\udc00"), /source must be well-formed UTF-16/);
	assert.throws(
		() => runtime.format("source", "file-\ud800.txt"),
		/filename must be well-formed UTF-16/,
	);
	assert.equal(fake.formatCallCount, 0);
});

test("rejects malformed partial edit framing", async (t) => {
	const cases = [
		{
			name: "missing count",
			payload: new Uint8Array(3),
			error: /missing its edit count/,
		},
		{
			name: "count exceeds available headers",
			payload: u32Bytes(1),
			error: /declares 1 edits but does not contain all edit headers/,
		},
		{
			name: "truncated replacement text",
			payload: encodeRawEditPayload(1, [[0, 0, 1, new Uint8Array()]]),
			error: /truncated replacement text/,
		},
		{
			name: "truncated later edit header",
			payload: encodeRawEditPayload(2, [[0, 0, 12, new Uint8Array(12)]]),
			error: /edit 1 has a truncated header/,
		},
		{
			name: "trailing bytes",
			payload: new Uint8Array([0, 0, 0, 0, 42]),
			error: /trailing bytes/,
		},
	];

	for (const testCase of cases) {
		await t.test(testCase.name, () => {
			const fake = createFakeWasm();
			fake.formatStatus = 2;
			fake.output = testCase.payload;
			const runtime = createBridgeRuntime(fake.exports);

			assert.throws(() => runtime.format("source"), testCase.error);
			assert.equal(fake.resetCount, 0);
			assert.throws(() => runtime.format("source"), /unusable/);
		});
	}
});

test("validates every partial edit before applying the result", async (t) => {
	const cases = [
		{
			name: "start after end",
			source: "abc",
			edits: [{ start: 2, end: 1, text: "" }],
			error: /start greater than end/,
		},
		{
			name: "range beyond source",
			source: "abc",
			edits: [{ start: 0, end: 4, text: "" }],
			error: /outside the source byte range/,
		},
		{
			name: "range start splits a UTF-8 character",
			source: "a😀b",
			edits: [{ start: 2, end: 5, text: "" }],
			error: /UTF-8 character boundaries/,
		},
		{
			name: "range end splits a UTF-8 character",
			source: "a😀b",
			edits: [{ start: 1, end: 4, text: "" }],
			error: /UTF-8 character boundaries/,
		},
		{
			name: "overlapping ranges",
			source: "abcd",
			edits: [
				{ start: 0, end: 2, text: "x" },
				{ start: 1, end: 3, text: "y" },
			],
			error: /ordered and non-overlapping/,
		},
		{
			name: "descending insertions",
			source: "abcd",
			edits: [
				{ start: 2, end: 2, text: "x" },
				{ start: 1, end: 1, text: "y" },
			],
			error: /ordered and non-overlapping/,
		},
		{
			name: "invalid replacement UTF-8 after a valid edit",
			source: "abcd",
			edits: [
				{ start: 0, end: 1, text: "x" },
				{ start: 2, end: 3, text: new Uint8Array([0xff]) },
			],
			error: /replacement text must be valid UTF-8/,
		},
	];

	for (const testCase of cases) {
		await t.test(testCase.name, () => {
			const fake = createFakeWasm();
			fake.formatStatus = 2;
			fake.output = encodeTextEdits(testCase.edits);
			const runtime = createBridgeRuntime(fake.exports);

			assert.throws(() => runtime.format(testCase.source), testCase.error);
			assert.equal(fake.resetCount, 0);
			assert.throws(() => runtime.format("source"), /unusable/);
		});
	}
});

test("encodes inline and registered configuration", () => {
	const fake = createFakeWasm();
	const runtime = createBridgeRuntime(fake.exports, {
		encodeConfig(config) {
			return encoder.encode(JSON.stringify(config));
		},
	});

	runtime.format("source", { indent: 2 });
	const inlineFields = readFields(fake.lastRequest);
	assert.equal(inlineFields[1][0], 3);
	assert.equal(decoder.decode(inlineFields[1][1]), '{"indent":2}');

	const handle = runtime.createConfig({ indent: 4 });
	assert.equal(decoder.decode(fake.registeredConfig), '{"indent":4}');

	runtime.format("source", handle);
	const registeredFields = readFields(fake.lastRequest);
	assert.equal(registeredFields[1][0], 4);
	assert.equal(new DataView(registeredFields[1][1].buffer).getUint32(0, true), 1);

	runtime.releaseConfig(handle);
	assert.deepEqual(fake.releasedConfigIds, [1]);
	assert.throws(() => runtime.format("source", handle), /unknown or released config handle/);
});

test("requires configuration encoders to return u32-sized byte arrays", () => {
	const fake = createFakeWasm();
	const invalidRuntime = createBridgeRuntime(fake.exports, {
		encodeConfig: () => [],
	});

	assert.throws(
		() => invalidRuntime.format("source", {}),
		/encodeConfig must return a Uint8Array/,
	);

	class OversizedBytes extends Uint8Array {
		get length() {
			return 0x1_0000_0000;
		}
	}
	const oversizedRuntime = createBridgeRuntime(createFakeWasm().exports, {
		encodeConfig: () => new OversizedBytes(),
	});

	assert.throws(
		() => oversizedRuntime.createConfig({}),
		/encoded configuration exceeds the maximum u32 byte length/,
	);
	assert.equal(fake.formatCallCount, 0);
});

test("uses the final u32 config id once and then reports exhaustion", () => {
	const fake = createFakeWasm();
	const runtime = createBridgeRuntime(fake.exports, {
		encodeConfig: () => new Uint8Array(),
	});
	runtime.nextConfigId = 0xffff_ffff;

	const handle = runtime.createConfig({});
	assert.deepEqual(fake.registeredConfigIds, [0xffff_ffff]);

	runtime.format("source", handle);
	const fields = readFields(fake.lastRequest);
	assert.equal(fields[1][0], 4);
	assert.equal(new DataView(fields[1][1].buffer).getUint32(0, true), 0xffff_ffff);

	assert.throws(() => runtime.createConfig({}), /config id space is exhausted/);
	assert.deepEqual(fake.registeredConfigIds, [0xffff_ffff]);
});

test("reports ABI, formatter, and config registration errors", () => {
	const wrongVersion = createFakeWasm();
	wrongVersion.abiVersion = 2;
	assert.throws(() => createBridgeRuntime(wrongVersion.exports), /unsupported wasm-fmt ABI version 2/);

	const formatterError = createFakeWasm();
	formatterError.formatStatus = 3;
	formatterError.error = "invalid source";
	const runtime = createBridgeRuntime(formatterError.exports);
	assert.throws(() => runtime.format("source"), /invalid source/);

	const configError = createFakeWasm();
	configError.registerConfigStatus = 3;
	configError.error = "invalid config";
	const configurableRuntime = createBridgeRuntime(configError.exports, {
		encodeConfig: () => new Uint8Array(),
	});
	assert.throws(() => configurableRuntime.createConfig({}), /invalid config/);
	assert.equal(configError.resetCount, 1);
});

test("rejects unsupported format and register status codes", () => {
	const invalidFormat = createFakeWasm();
	invalidFormat.formatStatus = 4;
	const runtime = createBridgeRuntime(invalidFormat.exports);
	assert.throws(() => runtime.format("source"), /unsupported status 4/);

	const invalidRegister = createFakeWasm();
	invalidRegister.registerConfigStatus = 2;
	const configurableRuntime = createBridgeRuntime(invalidRegister.exports, {
		encodeConfig: () => new Uint8Array(),
	});
	assert.throws(() => configurableRuntime.createConfig({}), /unsupported status 2/);
});

test("rejects invalid ByteString framing and full-output UTF-8", async (t) => {
	await t.test("truncated header", () => {
		const fake = createFakeWasm();
		fake.outputPointer = fake.exports.memory.buffer.byteLength - 2;
		fake.writeOutput = false;
		const runtime = createBridgeRuntime(fake.exports);

		assert.throws(() => runtime.format("source"), /truncated ByteString header/);
	});

	await t.test("payload beyond memory", () => {
		const fake = createFakeWasm();
		fake.writeOutput = false;
		new DataView(fake.exports.memory.buffer).setUint32(fake.outputPointer, 0xffff_ffff, true);
		const runtime = createBridgeRuntime(fake.exports);

		assert.throws(() => runtime.format("source"), /extends past wasm memory/);
	});

	await t.test("invalid full-output UTF-8", () => {
		const fake = createFakeWasm();
		fake.output = new Uint8Array([0xff]);
		const runtime = createBridgeRuntime(fake.exports);

		assert.throws(() => runtime.format("source"), /wasm_fmt_output payload must be valid UTF-8/);
	});
});

test("one runtime owns an instance, including aliases of its exports", () => {
	const fake = createFakeWasm();
	createBridgeRuntime(fake.exports);
	assert.throws(() => createBridgeRuntime(fake.exports), /already has a runtime owner/);
	assert.throws(() => createBridgeRuntime({ ...fake.exports }), /already has a runtime owner/);
	const shared = createFakeWasm();
	shared.exports.memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
	assert.throws(() => createBridgeRuntime(shared.exports), /unshared/);
});

test("config encoders cannot reenter the same runtime", () => {
	const fake = createFakeWasm();
	const runtime = createBridgeRuntime(fake.exports, {
		encodeConfig() {
			runtime.format("nested");
			return new Uint8Array();
		},
	});
	assert.throws(() => runtime.createConfig({}), /reentrant/);
	assert.equal(fake.formatCallCount, 0);
	assert.equal(runtime.format("source"), "");
});

test("guest failures retire the instance at every transaction stage", async (t) => {
	for (const name of ["wasm_fmt_alloc", "wasm_fmt_format", "wasm_fmt_output", "wasm_fmt_reset", "wasm_fmt_register_config", "wasm_fmt_release_config"]) {
		await t.test(name, () => {
			const fake = createFakeWasm();
			const runtime = createBridgeRuntime(fake.exports, { encodeConfig: () => new Uint8Array() });
			const handle = runtime.createConfig({});
			const trap = new WebAssembly.RuntimeError("guest trap");
			fake.exports[name] = () => { throw trap; };
			let operation = () => runtime.format("source");
			if (name === "wasm_fmt_register_config") operation = () => runtime.createConfig({});
			if (name === "wasm_fmt_release_config") operation = () => runtime.releaseConfig(handle);
			assert.throws(operation, (error) => error === trap);
			assert.throws(() => runtime.format("source"), /unusable/);
			assert.throws(() => runtime.createConfig({}), /unusable/);
			assert.throws(() => runtime.releaseConfig(handle), /unusable/);
		});
	}
	await t.test("invalid allocation", () => {
		const fake = createFakeWasm();
		fake.exports.wasm_fmt_alloc = () => fake.exports.memory.buffer.byteLength;
		const runtime = createBridgeRuntime(fake.exports);
		assert.throws(() => runtime.format("source"), RangeError);
		assert.throws(() => runtime.format("source"), /unusable/);
	});
});

function createFakeWasm() {
	const memory = new WebAssembly.Memory({ initial: 1 });
	const inputPointer = 1024;
	const outputPointer = 32768;
	const errorPointer = 49152;

	const fake = {
		abiVersion: 1,
		error: "",
		formatCallCount: 0,
		formatStatus: 1,
		lastEndpoint: undefined,
		lastRequest: new Uint8Array(),
		output: "",
		outputPointer,
		registerConfigStatus: 1,
		registeredConfig: new Uint8Array(),
		registeredConfigIds: [],
		releasedConfigIds: [],
		resetCount: 0,
		writeOutput: true,
	};

	fake.exports = {
		memory,
		wasm_fmt_abi_version() {
			return fake.abiVersion;
		},
		wasm_fmt_alloc() {
			return inputPointer;
		},
		wasm_fmt_reset() {
			fake.resetCount++;
		},
		wasm_fmt_register_config(id, ptr, len) {
			fake.registeredConfigIds.push(id);
			fake.registeredConfig = new Uint8Array(memory.buffer, ptr, len).slice();
			return fake.registerConfigStatus;
		},
		wasm_fmt_release_config(id) {
			fake.releasedConfigIds.push(id);
		},
		wasm_fmt_format(ptr, len) {
			recordFormatCall("format", ptr, len);
			return fake.formatStatus;
		},
		wasm_fmt_format_range(ptr, len) {
			recordFormatCall("format_range", ptr, len);
			return fake.formatStatus;
		},
		wasm_fmt_format_embedded(ptr, len) {
			recordFormatCall("format_embedded", ptr, len);
			return fake.formatStatus;
		},
		wasm_fmt_output() {
			if (fake.writeOutput) {
				writeByteString(memory, fake.outputPointer, fake.output);
			}
			return fake.outputPointer;
		},
		wasm_fmt_error() {
			writeByteString(memory, errorPointer, fake.error);
			return errorPointer;
		},
	};

	function recordFormatCall(endpoint, ptr, len) {
			fake.formatCallCount++;
			fake.lastEndpoint = endpoint;
			fake.lastRequest = new Uint8Array(memory.buffer, ptr, len).slice();
	}

	return fake;
}

function writeByteString(memory, ptr, value) {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	const view = new DataView(memory.buffer);
	view.setUint32(ptr, bytes.length, true);
	new Uint8Array(memory.buffer, ptr + 4, bytes.length).set(bytes);
}

function encodeTextEdits(edits) {
	const rawEdits = edits.map(({ start, end, text }) => {
		const bytes = typeof text === "string" ? encoder.encode(text) : text;
		return [start, end, bytes.length, bytes];
	});
	return encodeRawEditPayload(rawEdits.length, rawEdits);
}

function encodeRawEditPayload(count, edits) {
	const length = 4 + edits.reduce((total, edit) => total + 12 + edit[3].length, 0);
	const payload = new Uint8Array(length);
	const view = new DataView(payload.buffer);
	view.setUint32(0, count, true);

	let offset = 4;
	for (const [start, end, textLength, text] of edits) {
		view.setUint32(offset, start, true);
		view.setUint32(offset + 4, end, true);
		view.setUint32(offset + 8, textLength, true);
		offset += 12;
		payload.set(text, offset);
		offset += text.length;
	}

	return payload;
}

function u32Bytes(value) {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, true);
	return bytes;
}

function readFields(request) {
	assert.equal(decoder.decode(request.subarray(0, 8)), "WASM-FMT");

	const fields = [];
	const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
	let offset = 8;

	while (offset < request.length) {
		const tag = view.getUint16(offset, true);
		const flags = view.getUint16(offset + 2, true);
		const length = view.getUint32(offset + 4, true);
		offset += 8;
		assert.equal(flags, 0);
		fields.push([tag, request.slice(offset, offset + length)]);
		offset += length;
	}

	return fields;
}


test("input allocation accepts signed i32 pointers above 2 GiB", () => {
	const allocator = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from([
		0, 97, 115, 109, 1, 0, 0, 0,
		1, 6, 1, 96, 1, 127, 1, 127,
		3, 2, 1, 0,
		7, 9, 1, 5, 97, 108, 108, 111, 99, 0, 0,
		10, 10, 1, 8, 0, 65, 128, 128, 128, 128, 120, 11,
	])));
	const memory = new WebAssembly.Memory({ initial: 32769 });
	let calls = 0;
	const runtime = createBridgeRuntime({
		memory,
		wasm_fmt_abi_version: () => 1,
		wasm_fmt_alloc: allocator.exports.alloc,
		wasm_fmt_format(ptr, len) {
			assert.equal(ptr, 0x80000000);
			assert.equal(new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, 8)), "WASM-FMT");
			assert.ok(len > 8);
			calls++;
			return 0;
		},
		wasm_fmt_reset() {},
	});
	assert.equal(allocator.exports.alloc(1), -2147483648);
	assert.equal(runtime.format("first"), "first");
	assert.equal(runtime.format("second"), "second");
	assert.equal(calls, 2);
});
