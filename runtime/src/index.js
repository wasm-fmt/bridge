import { EmbeddedHost } from "./host.js";

const ABI_VERSION = 1;

const STATUS_NONE = 0;
const STATUS_OK = 1;
const STATUS_PARTIAL = 2;
const STATUS_ERROR = 3;

const TAG_SOURCE = 1;
const TAG_FILENAME = 2;
const TAG_INLINE_CONFIG = 3;
const TAG_REGISTERED_CONFIG = 4;
const TAG_RANGES = 5;

const FIELD_HEADER_SIZE = 8;
const EDIT_HEADER_SIZE = 12;
const MAX_CONFIG_ID = 0xffff_ffff;
const MAX_U32 = 0xffff_ffff;
const MAGIC = new Uint8Array([0x57, 0x41, 0x53, 0x4d, 0x2d, 0x46, 0x4d, 0x54]);
const ENDPOINT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENDPOINT_NAMES = new Set([
	"abi_version",
	"alloc",
	"reset",
	"register_config",
	"release_config",
	"output",
	"error",
]);

const ownedMemories = new WeakSet();

class FormatterError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * @param {BridgeExports} wasm
 * @param {RuntimeOptions} [options]
 */
export function createBridgeRuntime(wasm, options = {}) {
	return createBridgeHost().createRuntime(wasm, options);
}

/** Creates the imports and runtime owner for one guest instance. */
export function createBridgeHost() {
	const host = new EmbeddedHost();
	return Object.freeze({
		imports: host.imports,
		createRuntime(wasm, options = {}) {
			return attachRuntime(wasm, options, host);
		},
	});
}

function attachRuntime(wasm, options, host) {
	if (wasm === undefined) {
		throw new Error("WASM module has not been initialized");
	}

	const memory = wasm.memory;
	const shared = typeof SharedArrayBuffer !== "undefined" && memory?.buffer instanceof SharedArrayBuffer;
	if (!(memory instanceof WebAssembly.Memory) || shared) {
		throw new TypeError("Bridge requires an unshared WebAssembly memory");
	}
	if (ownedMemories.has(wasm.memory)) {
		throw new Error("Bridge instance already has a runtime owner");
	}
	ownedMemories.add(wasm.memory);

	const abiVersion = wasm.wasm_fmt_abi_version();
	if (abiVersion !== ABI_VERSION) {
		throw new Error(`unsupported wasm-fmt ABI version ${abiVersion}; expected ${ABI_VERSION}`);
	}

	return new FormatterRuntime(wasm, options.encodeConfig, host);
}

class FormatterRuntime {
	#state = "ready";
	/**
	 * @param {BridgeExports} wasm
	 * @param {EncodeConfig | undefined} encodeConfig
	 */
	constructor(wasm, encodeConfig, host) {
		this.host = host;
		host.bind(wasm, () => this.#fail());
		this.wasm = wasm;
		this.encodeConfig = encodeConfig;
		this.nextConfigId = 1;
		this.configs = new Map();
	}

	/**
	 * @param {string} source
	 * @param {string | object | symbol} [filename]
	 * @param {unknown} [config]
	 */
	format(source, filename, config) {
		const normalized = normalizeFormatArguments(filename, config);
		return this.invoke("format", source, normalized);
	}

	/**
	 * @param {string} source
	 * @param {readonly TextRange[]} ranges
	 * @param {string | object | symbol} [filename]
	 * @param {unknown} [config]
	 */
	formatRanges(source, ranges, filename, config) {
		const normalized = normalizeFormatArguments(filename, config);
		const options = { ...normalized, ranges };

		const endpoint =
			this.wasm.wasm_fmt_format_range === undefined ? "format" : "format_range";
		return this.invoke(endpoint, source, options);
	}

	/**
	 * @param {string} endpoint
	 * @param {string} source
	 * @param {InvokeOptions} [options]
	 */
	invoke(endpoint, source, options = {}) {
		return this.#run(() => {
			const formatterEndpoint = resolveFormatterEndpoint(this.wasm, endpoint);
			const normalizedOptions = normalizeInvokeOptions(options);
			const { request, sourceBytes } = createFormatRequest(source, normalizedOptions, this);
			return this.#transaction(() => {
				const ptr = writeBytesToWasmMemory(this.wasm, request);
				const status = this.host.invoke(normalizedOptions.onFormatEmbedded, () =>
					formatterEndpoint.call(this.wasm, ptr, request.length));
				switch (status) {
					case STATUS_NONE:
						return source;
					case STATUS_OK: {
						const ptr = this.wasm.wasm_fmt_output();
						return readByteStringAsText(this.wasm, ptr, "wasm_fmt_output");
					}
					case STATUS_PARTIAL: {
						const ptr = this.wasm.wasm_fmt_output();
						const payload = readByteString(this.wasm, ptr, "wasm_fmt_output");
						return applyPartialUpdate(sourceBytes, payload);
					}
					case STATUS_ERROR:
						throw new FormatterError(readError(this.wasm));
					default:
						throw new Error(`wasm_fmt_${endpoint} returned unsupported status ${status}`);
				}
			});
		});
	}

	/** @param {unknown} [config] */
	createConfig(config) {
		return this.#run(() => {
			const bytes = this.encodeConfigInput(config);
			const id = this.allocateConfigId();
			return this.#transaction(() => {
				const ptr = writeBytesToWasmMemory(this.wasm, bytes);
				const status = this.wasm.wasm_fmt_register_config(id, ptr, bytes.length);
				if (status === STATUS_ERROR) {
					throw new FormatterError(readError(this.wasm));
				}
				if (status !== STATUS_OK) {
					throw new Error(`wasm_fmt_register_config returned unsupported status ${status}`);
				}
				const handle = Symbol("wasm-fmt-config");
				this.configs.set(handle, id);
				return handle;
			});
		});
	}

	/**
	 * @template T
	 * @param {() => T} operation
	 * @returns {T}
	 */
	#run(operation) {
		if (this.#state !== "ready") {
			const message = this.#state === "failed"
				? "Bridge instance is unusable after a guest failure; create a new instance"
				: "Bridge calls must not be reentrant";
			throw new Error(message);
		}
		this.#state = "busy";
		try {
			return operation();
		} finally {
			if (this.#state === "busy") {
				this.#state = "ready";
			}
		}
	}

	/**
	 * Starts before allocation. Only a normal ABI response permits reset;
	 * traps and malformed guest responses permanently invalidate the instance.
	 * @template T
	 * @param {() => T} operation
	 * @returns {T}
	 */
	#transaction(operation) {
		try {
			return operation();
		} catch (error) {
			if (!(error instanceof FormatterError)) {
				this.#fail();
			}
			throw error;
		} finally {
			if (this.#state !== "failed") {
				try {
					this.wasm.wasm_fmt_reset();
				} catch (error) {
					this.#fail();
					throw error;
				}
			}
		}
	}

	#fail() {
		this.#state = "failed";
		this.configs.clear();
	}

	allocateConfigId() {
		const id = this.nextConfigId;
		if (!Number.isSafeInteger(id) || id < 1 || id > MAX_CONFIG_ID) {
			throw new Error("wasm-fmt config id space is exhausted");
		}

		this.nextConfigId = id + 1;
		return id;
	}

	/**
	 * @param {symbol} handle
	 */
	releaseConfig(handle) {
		this.#run(() => {
			const id = this.configs.get(handle);
			if (id === undefined) {
				return;
			}
			this.#transaction(() => {
				this.wasm.wasm_fmt_release_config(id);
				this.configs.delete(handle);
			});
		});
	}

	/**
	 * @param {unknown} config
	 */
	encodeConfigInput(config) {
		if (this.encodeConfig === undefined) {
			throw new Error("this formatter does not accept configuration");
		}
		const bytes = this.encodeConfig(config);
		if (!(bytes instanceof Uint8Array)) {
			throw new TypeError("encodeConfig must return a Uint8Array");
		}
		assertU32Length(bytes.length, "encoded configuration");
		return bytes;
	}
}

/**
 * @param {string | object | symbol | undefined} filename
 * @param {unknown} config
 * @returns {InvokeOptions}
 */
function normalizeFormatArguments(filename, config) {
	if (typeof filename === "string" || filename === undefined) {
		return { filename, config };
	}
	if (config !== undefined) {
		throw new TypeError("filename must be a string");
	}
	return { config: filename };
}

/**
 * @param {unknown} options
 * @returns {InvokeOptions}
 */
function normalizeInvokeOptions(options) {
	if (options === null || typeof options !== "object" || Array.isArray(options)) {
		throw new TypeError("formatter invocation options must be an object");
	}

	if (options.onFormatEmbedded !== undefined && typeof options.onFormatEmbedded !== "function") {
		throw new TypeError("onFormatEmbedded must be a function");
	}
	return options;
}

/**
 * @param {BridgeExports} wasm
 * @param {string} endpoint
 * @returns {(ptr: number, len: number) => number}
 */
function resolveFormatterEndpoint(wasm, endpoint) {
	if (typeof endpoint !== "string" || !ENDPOINT_NAME.test(endpoint)) {
		throw new TypeError(
			"formatter endpoint name must be an ASCII identifier containing only letters, digits, and underscores",
		);
	}
	if (RESERVED_ENDPOINT_NAMES.has(endpoint)) {
		throw new Error(`wasm_fmt_${endpoint} is a Bridge core export, not a formatter endpoint`);
	}

	const exportName = `wasm_fmt_${endpoint}`;
	const endpointFunction = Object.hasOwn(wasm, exportName) ? wasm[exportName] : undefined;
	if (typeof endpointFunction !== "function") {
		throw new Error(`formatter endpoint ${exportName} is not exported`);
	}

	return /** @type {(ptr: number, len: number) => number} */ (endpointFunction);
}

/**
 * @param {string} source
 * @param {InvokeOptions} options
 * @param {FormatterRuntime} runtime
 * @return {{ request: Uint8Array, sourceBytes: Uint8Array }}
 */
function createFormatRequest(source, options, runtime) {
	const { filename, config, ranges } = options;
	const sourceBytes = encodeUtf8(source, "source");
	const rangesBytes = ranges === undefined ? undefined : encodeRanges(ranges, sourceBytes);

	/** @type {{ tag: number, bytes: Uint8Array }[]} */
	const fields = [
		{
			tag: TAG_SOURCE,
			bytes: sourceBytes,
		},
	];

	if (filename !== undefined) {
		fields.push({
			tag: TAG_FILENAME,
			bytes: encodeUtf8(filename, "filename"),
		});
	}

	if (config !== undefined) {
		if (typeof config === "symbol") {
			const id = runtime.configs.get(config);
			if (id === undefined) {
				throw new Error("unknown or released config handle");
			}
			const bytes = new Uint8Array(4);
			new DataView(bytes.buffer).setUint32(0, id, true);
			fields.push({
				tag: TAG_REGISTERED_CONFIG,
				bytes,
			});
		} else {
			fields.push({
				tag: TAG_INLINE_CONFIG,
				bytes: runtime.encodeConfigInput(config),
			});
		}
	}

	if (rangesBytes !== undefined) {
		fields.push({
			tag: TAG_RANGES,
			bytes: rangesBytes,
		});
	}

	let totalLength = MAGIC.length;
	for (const field of fields) {
		totalLength = checkedU32Add(totalLength, FIELD_HEADER_SIZE, "format request");
		totalLength = checkedU32Add(totalLength, field.bytes.length, "format request");
	}
	const request = new Uint8Array(totalLength);
	const view = new DataView(request.buffer);
	request.set(MAGIC, 0);

	let offset = MAGIC.length;
	for (const field of fields) {
		view.setUint16(offset, field.tag, true);
		view.setUint16(offset + 2, 0, true);
		view.setUint32(offset + 4, field.bytes.length, true);
		offset += FIELD_HEADER_SIZE;
		request.set(field.bytes, offset);
		offset += field.bytes.length;
	}

	return { request, sourceBytes };
}

/**
 * @param {readonly TextRange[]} ranges
 * @param {Uint8Array} source
 * @returns {Uint8Array}
 */
function encodeRanges(ranges, source) {
	if (!Array.isArray(ranges)) {
		throw new TypeError("ranges must be an array");
	}

	const rangeCount = ranges.length;
	const maximumRangeCount = Math.floor((0xffff_ffff - 4) / 8);
	if (rangeCount > maximumRangeCount) {
		throw new RangeError("ranges exceed the maximum supported payload length");
	}

	const payload = new Uint8Array(4 + rangeCount * 8);
	const view = new DataView(payload.buffer);
	view.setUint32(0, rangeCount, true);

	let offset = 4;
	for (let index = 0; index < rangeCount; index++) {
		const range = ranges[index];
		if (range === null || typeof range !== "object") {
			throw new TypeError(`ranges[${index}] must be an object with start and end`);
		}

		const { start, end } = range;
		if (!isU32(start) || !isU32(end)) {
			throw new TypeError(
				`ranges[${index}] start and end must be unsigned 32-bit integers`,
			);
		}
		if (start > end) {
			throw new RangeError(`ranges[${index}] has start greater than end`);
		}
		if (end > source.length) {
			throw new RangeError(`ranges[${index}] is outside the source byte range`);
		}
		if (!isUtf8Boundary(source, start) || !isUtf8Boundary(source, end)) {
			throw new RangeError(
				`ranges[${index}] does not fall on UTF-8 character boundaries`,
			);
		}

		view.setUint32(offset, start, true);
		view.setUint32(offset + 4, end, true);
		offset += 8;
	}

	return payload;
}

/**
 * @param {unknown} value
 */
function isU32(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_U32;
}

/**
 * @param {string} value
 * @param {string} field
 */
function encodeUtf8(value, field) {
	if (typeof value !== "string") {
		throw new TypeError(`${field} must be a string`);
	}
	if (!isWellFormedUtf16(value)) {
		throw new TypeError(`${field} must be well-formed UTF-16`);
	}

	return encoder.encode(value);
}

/**
 * @param {string} value
 */
function isWellFormedUtf16(value) {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);

		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) {
				return false;
			}
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) {
				return false;
			}
			index++;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}

	return true;
}

/**
 * @param {BridgeExports} wasm
 * @param {Uint8Array} bytes
 */
function writeBytesToWasmMemory(wasm, bytes) {
	assertU32Length(bytes.length, "WASM input");
	const ptr = wasm.wasm_fmt_alloc(bytes.length) >>> 0;
	if (bytes.length === 0) {
		return ptr;
	}

	const memory = new Uint8Array(wasm.memory.buffer, ptr, bytes.length);
	memory.set(bytes);
	return ptr;
}

/** @param {number} length @param {string} context */
function assertU32Length(length, context) {
	if (!Number.isSafeInteger(length) || length < 0 || length > MAX_U32) {
		throw new RangeError(`${context} exceeds the maximum u32 byte length`);
	}
}

/** @param {number} left @param {number} right @param {string} context */
function checkedU32Add(left, right, context) {
	assertU32Length(left, context);
	assertU32Length(right, context);
	if (right > MAX_U32 - left) {
		throw new RangeError(`${context} exceeds the maximum u32 byte length`);
	}
	return left + right;
}

/**
 * @param {BridgeExports} wasm
 * @param {number} ptr
 * @param {string} context
 */
function readByteStringAsText(wasm, ptr, context) {
	const bytes = readByteString(wasm, ptr, context);
	return decodeUtf8(bytes, `${context} payload`);
}

/**
 * @param {BridgeExports} wasm
 * @param {number} ptr
 * @param {string} context
 */
function readByteString(wasm, ptr, context) {
	const offset = ptr >>> 0;
	const memory = new Uint8Array(wasm.memory.buffer);

	if (offset > memory.length - 4) {
		throw new Error(`${context} returned a truncated ByteString header`);
	}

	const view = new DataView(memory.buffer, memory.byteOffset + offset, 4);
	const length = view.getUint32(0, true);
	const payloadOffset = offset + 4;

	if (length > memory.length - payloadOffset) {
		throw new Error(`${context} returned a ByteString payload that extends past wasm memory`);
	}

	return memory.slice(payloadOffset, payloadOffset + length);
}

/**
 * @param {Uint8Array} bytes
 * @param {string} context
 */
function decodeUtf8(bytes, context) {
	try {
		return decoder.decode(bytes);
	} catch {
		throw new Error(`${context} must be valid UTF-8`);
	}
}

/**
 * @param {Uint8Array} sourceBytes
 * @param {Uint8Array} payload
 */
function applyPartialUpdate(sourceBytes, payload) {
	const edits = parseTextEdits(payload, sourceBytes);

	let outputLength = sourceBytes.length;
	for (const edit of edits) {
		outputLength += edit.text.length - (edit.end - edit.start);
	}

	if (outputLength > 0xffff_ffff) {
		throw new Error("partial update exceeds the maximum supported byte length");
	}

	const output = new Uint8Array(outputLength);
	let inputOffset = 0;
	let outputOffset = 0;

	for (const edit of edits) {
		const unchanged = sourceBytes.subarray(inputOffset, edit.start);
		output.set(unchanged, outputOffset);
		outputOffset += unchanged.length;

		output.set(edit.text, outputOffset);
		outputOffset += edit.text.length;
		inputOffset = edit.end;
	}

	output.set(sourceBytes.subarray(inputOffset), outputOffset);
	return decodeUtf8(output, "partial update");
}

/**
 * @param {Uint8Array} payload
 * @param {Uint8Array} source
 * @returns {TextEdit[]}
 */
function parseTextEdits(payload, source) {
	if (payload.length < 4) {
		throw new Error("partial update is missing its edit count");
	}

	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const count = view.getUint32(0, true);
	const maximumHeaderCount = Math.floor((payload.length - 4) / EDIT_HEADER_SIZE);

	if (count > maximumHeaderCount) {
		throw new Error(`partial update declares ${count} edits but does not contain all edit headers`);
	}

	const edits = [];
	let offset = 4;
	let previousEnd = 0;

	for (let index = 0; index < count; index++) {
		if (payload.length - offset < EDIT_HEADER_SIZE) {
			throw new Error(`partial update edit ${index} has a truncated header`);
		}

		const start = view.getUint32(offset, true);
		const end = view.getUint32(offset + 4, true);
		const textLength = view.getUint32(offset + 8, true);
		offset += EDIT_HEADER_SIZE;

		if (start > end) {
			throw new Error(`partial update edit ${index} has start greater than end`);
		}
		if (end > source.length) {
			throw new Error(`partial update edit ${index} is outside the source byte range`);
		}
		if (!isUtf8Boundary(source, start) || !isUtf8Boundary(source, end)) {
			throw new Error(`partial update edit ${index} does not fall on UTF-8 character boundaries`);
		}
		if (start < previousEnd) {
			throw new Error("partial update edits must be ordered and non-overlapping");
		}
		if (textLength > payload.length - offset) {
			throw new Error(`partial update edit ${index} has truncated replacement text`);
		}

		const text = payload.slice(offset, offset + textLength);
		decodeUtf8(text, `partial update edit ${index} replacement text`);
		edits.push({ start, end, text });

		offset += textLength;
		previousEnd = end;
	}

	if (offset !== payload.length) {
		throw new Error("partial update has trailing bytes after its declared edits");
	}

	return edits;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function isUtf8Boundary(bytes, offset) {
	return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

/**
 * @param {BridgeExports} wasm
 */
function readError(wasm) {
	const message = readByteStringAsText(wasm, wasm.wasm_fmt_error(), "wasm_fmt_error");
	return message || "unknown formatter error";
}

/**
 * @callback EncodeConfig
 * @param {unknown} config
 * @returns {Uint8Array}
 */

/** @typedef {import("./index.d.ts").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./index.d.ts").InvokeOptions} InvokeOptions */
/** @typedef {import("./index.d.ts").BridgeExports} BridgeExports */
/** @typedef {import("./index.d.ts").TextRange} TextRange */

/**
 * @typedef TextEdit
 * @property {number} start
 * @property {number} end
 * @property {Uint8Array} text
 */

export { createFormatterContext } from "./context.js";
