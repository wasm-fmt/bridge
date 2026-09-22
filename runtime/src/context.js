import { discardAsyncResult } from "./host.js";

/** Compose independently initialized formatter packages without global state. */
export function createFormatterContext() {
	const extensions = new Map();
	const fileNames = new Map();
	const active = new Set();

	function invoke(entry, request) {
		if (active.has(entry)) throw new Error("cyclic embedded formatter dispatch");
		active.add(entry);
		try {
			const result = entry.format({ ...request, onFormatEmbedded: embedded });
			if (typeof result !== "string" || !result.isWellFormed()) {
				discardAsyncResult(result);
				throw new TypeError("context formatter must return a well-formed string synchronously");
			}
			return result;
		} finally {
			active.delete(entry);
		}
	}

	function select(request) {
		if (
			request === null || typeof request !== "object" || typeof request.filename !== "string" ||
			request.filename.length === 0 || typeof request.source !== "string"
		) {
			throw new TypeError("context request requires filename and source strings");
		}
		if (!request.source.isWellFormed() || !request.filename.isWellFormed()) {
			throw new TypeError("context source and filename must be well-formed UTF-16");
		}
		const width = request.lineWidth;
		if (width !== undefined && (!Number.isInteger(width) || width <= 0 || width > 0xffff_ffff)) {
			throw new TypeError("context lineWidth must be a positive u32");
		}
		const name = request.filename.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
		const dot = name.lastIndexOf(".");
		const extension = dot < 0 ? "" : name.slice(dot + 1);
		return fileNames.get(name) ?? extensions.get(extension);
	}

	function embedded(request) {
		const entry = select(request);
		return entry === undefined ? undefined : invoke(entry, request);
	}

	return Object.freeze({
		addFormatter(registration) {
			if (active.size !== 0) throw new Error("cannot register formatters during formatting");
			if (registration === null || typeof registration !== "object" || typeof registration.format !== "function") {
				throw new TypeError("formatter registration requires a format function");
			}
			const names = normalizeNames(registration.fileNames ?? [], "file name");
			const suffixes = normalizeNames(registration.extensions ?? [], "extension");
			if (names.length + suffixes.length === 0) throw new Error("formatter requires file names or extensions");
			for (const name of names) if (fileNames.has(name)) throw new Error(`duplicate formatter file name: ${name}`);
			for (const extension of suffixes) {
				if (extensions.has(extension)) throw new Error(`duplicate formatter extension: ${extension}`);
			}
			const entry = { format: registration.format };
			for (const name of names) fileNames.set(name, entry);
			for (const extension of suffixes) extensions.set(extension, entry);
		},
		format(request) {
			const entry = select(request);
			if (entry === undefined) throw new Error(`no formatter registered for ${request.filename}`);
			return invoke(entry, request);
		},
	});
}

function normalizeNames(values, label) {
	if (!Array.isArray(values)) throw new TypeError(`${label}s must be an array`);
	const result = new Set();
	for (const value of values) {
		if (
			typeof value !== "string" || value.length === 0 || /[\\/]/.test(value) ||
			(label === "extension" && value.includes("."))
		) throw new TypeError(`invalid formatter ${label}`);
		const name = value.toLowerCase();
		if (result.has(name)) throw new Error(`duplicate formatter ${label}: ${name}`);
		result.add(name);
	}
	return [...result];
}
