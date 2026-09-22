const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const magic = encoder.encode("WASM-EMB");

// One controller per instance. No request data or callback lives at module scope.
export class EmbeddedHost {
	#wasm;
	#retire;
	#frame;

	constructor() {
		this.imports = Object.freeze({
			wasm_fmt_host: Object.freeze({
				format_embedded: (ptr, len) => this.#request(ptr, len),
				embedded_result_len: () => this.#result().length,
				read_embedded_result: (ptr, len) => this.#read(ptr, len),
			}),
		});
	}

	bind(wasm, retire) {
		if (this.#wasm !== undefined) throw new Error("Bridge host already has an instance");
		this.#wasm = wasm;
		this.#retire = retire;
	}

	invoke(callback, operation) {
		if (this.#frame !== undefined) this.#violation("embedded host is already active");
		const frame = { callback, pending: undefined, dispatching: false, failed: false };
		this.#frame = frame;
		try {
			const result = operation();
			if (frame.failed) this.#violation("embedded host protocol failed");
			if (frame.pending !== undefined) this.#violation("unconsumed embedded result");
			return result;
		} finally {
			this.#frame = undefined;
		}
	}

	#violation(message) {
		if (this.#frame !== undefined) this.#frame.failed = true;
		this.#retire?.();
		throw new Error(message);
	}

	#active() {
		const frame = this.#frame;
		if (frame === undefined || frame.dispatching || frame.failed) {
			this.#violation("embedded imports require an active formatter endpoint");
		}
		return frame;
	}

	#bytes(ptr, len) {
		const offset = ptr >>> 0;
		const length = len >>> 0;
		const buffer = this.#wasm.memory.buffer;
		if (offset > buffer.byteLength || length > buffer.byteLength - offset) {
			this.#violation("embedded buffer is outside wasm memory");
		}
		return new Uint8Array(buffer, offset, length);
	}

	#request(ptr, len) {
		const frame = this.#active();
		if (frame.pending !== undefined) this.#violation("unconsumed embedded result");
		let request;
		try {
			request = decodeRequest(this.#bytes(ptr, len));
		} catch (error) {
			this.#violation(safeMessage(error));
		}
		if (frame.callback === undefined) return 0;
		frame.dispatching = true;
		let status;
		try {
			const result = frame.callback(request);
			if (result === undefined) {
				status = 0;
			} else {
				if (typeof result !== "string") {
					discardAsyncResult(result);
					throw new TypeError("embedded formatter must return a string or undefined synchronously");
				}
				frame.pending = encodeText(result);
				status = 1;
			}
		} catch (error) {
			frame.pending = encoder.encode(safeMessage(error));
			status = 3;
		} finally {
			frame.dispatching = false;
		}
		if (frame.failed) this.#violation("embedded host protocol failed");
		return status;
	}

	#result() {
		const frame = this.#active();
		if (frame.pending === undefined) this.#violation("no pending embedded result");
		return frame.pending;
	}

	#read(ptr, len) {
		const result = this.#result();
		if ((len >>> 0) !== result.length) this.#violation("embedded result length mismatch");
		if (result.length === 0 && (ptr >>> 0) !== 0) this.#violation("empty embedded result requires pointer zero");
		this.#bytes(ptr, len).set(result);
		this.#frame.pending = undefined;
	}
}

function encodeText(text) {
	if (!text.isWellFormed()) throw new TypeError("embedded result must be well-formed UTF-16");
	const bytes = encoder.encode(text);
	if (bytes.length > 0xffff_ffff) throw new RangeError("embedded result exceeds u32 length");
	return bytes;
}

function safeMessage(error) {
	try {
		const message = error instanceof Error ? error.message : String(error);
		if (typeof message === "string" && message.length !== 0 && message.length <= 4096 && message.isWellFormed()) {
			return message;
		}
	} catch { /* A thrown object must not turn error reporting into a trap. */ }
	return "embedded formatter failed";
}

function decodeRequest(bytes) {
	if (bytes.length < 8 || !magic.every((byte, index) => bytes[index] === byte)) {
		throw new Error("invalid embedded request magic");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const result = {};
	let offset = 8;
	while (offset < bytes.length) {
		if (bytes.length - offset < 8) throw new Error("truncated embedded field header");
		const tag = view.getUint16(offset, true);
		const flags = view.getUint16(offset + 2, true);
		const length = view.getUint32(offset + 4, true);
		offset += 8;
		if ((flags & ~1) !== 0) throw new Error("unsupported embedded field flags");
		if (length > bytes.length - offset) throw new Error("truncated embedded field payload");
		const payload = bytes.subarray(offset, offset + length);
		offset += length;
		const field = { 1: "source", 2: "filename", 3: "lineWidth" }[tag];
		if (field === undefined) {
			if ((flags & 1) !== 0) throw new Error("unknown critical embedded field");
			continue;
		}
		if (Object.hasOwn(result, field)) throw new Error(`duplicate embedded ${field}`);
		if (tag === 3) {
			if (length !== 4) throw new Error("embedded line width must be u32");
			result.lineWidth = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
			if (result.lineWidth === 0) throw new Error("embedded line width must be positive");
		} else {
			result[field] = decoder.decode(payload);
		}
	}
	if (result.source === undefined || !result.filename) {
		throw new Error("embedded request requires source and nonempty filename");
	}
	return Object.freeze(result);
}

// Reject async APIs synchronously without leaving an ordinary rejected Promise
// unhandled in the application's event loop.
export function discardAsyncResult(value) {
	if (value instanceof Promise) Promise.prototype.then.call(value, undefined, () => {});
}
