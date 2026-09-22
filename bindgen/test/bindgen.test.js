import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { generateBindings } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("generates static bindings and initializes each adapter once", async () => {
	const fixture = await createFixture();
	const result = await generateBindings(fixture.config, {
		baseDir: fixture.root,
	});

	assert.deepEqual(result.endpoints, ["wasm_fmt_format"]);
	assert.deepEqual(result.exports, ["format"]);
	assert.equal(result.initialize, "_initialize");
	const sourceAdapter = await import(pathToFileURL(join(fixture.root, "adapter.js")));
	assert.equal(sourceAdapter.getFactoryCalls(), 1);

	const nodeModule = await import(pathToFileURL(join(fixture.outDir, "fixture_node.js")));
	assert.equal(nodeModule.format("first"), "FIRST");
	assert.equal(nodeModule.format("second"), "SECOND");

	const adapter = await import(pathToFileURL(join(fixture.outDir, "fixture_binding.js")));
	assert.equal(adapter.getFactoryCalls(), 1);
	assert.equal(nodeModule.format, adapter.getLastFormat());

	const webModule = await import(pathToFileURL(join(fixture.outDir, "fixture_web.js")));
	assert.throws(() => webModule.format("before"), /WASM module has not been initialized/);
	webModule.initSync(fixture.wasm);
	assert.equal(webModule.format("web"), "WEB");
	assert.equal(adapter.getFactoryCalls(), 2);
	assert.equal(webModule.format, adapter.getLastFormat());

	const wasmTypes = await readFile(join(fixture.outDir, "fixture.wasm.d.ts"), "utf8");
	assert.match(wasmTypes, /wasm_fmt_format\(ptr: number, len: number\): 0 \| 1 \| 2 \| 3/);
	assert.match(wasmTypes, /_initialize\(\): void/);

	const copiedAsset = await readFile(join(fixture.outDir, "NOTICE"), "utf8");
	assert.equal(copiedAsset, "fixture asset");
});

test("rejects imported, incomplete, and endpoint-less guests", async (context) => {
	const imported = await createFixture({ imports: true });
	await context.test("imports", async () => {
		await assert.rejects(generateBindings(imported.config, { baseDir: imported.root }), /zero imports/);
	});

	const incomplete = await createFixture({ omit: "wasm_fmt_error" });
	await context.test("missing core export", async () => {
		await assert.rejects(
			generateBindings(incomplete.config, { baseDir: incomplete.root }),
			/must export function wasm_fmt_error/,
		);
	});

	const endpointLess = await createFixture({ endpoint: false });
	await context.test("missing formatter endpoint", async () => {
		await assert.rejects(
			generateBindings(endpointLess.config, { baseDir: endpointLess.root }),
			/at least one formatter endpoint/,
		);
	});
});

test("validates inferred API names and destructive output settings", async () => {
	const declaredFixture = await createFixture();
	await assert.rejects(
		generateBindings(
			{
				...declaredFixture.config,
				exports: ["format"],
			},
			{ baseDir: declaredFixture.root },
		),
		/exports are inferred from adapter\.create\(wasm\)/,
	);

	for (const name of ["default", "initAsync", "__bridge_api"]) {
		const fixture = await createFixture();
		await writeFile(
			join(fixture.root, "adapter.js"),
			`export default {
	create() {
		return { ${JSON.stringify(name)}() {} };
	},
};
`,
		);
		await assert.rejects(
			generateBindings(fixture.config, { baseDir: fixture.root }),
			/invalid formatter adapter API export/,
		);
	}

	const fixture = await createFixture();
	await assert.rejects(
		generateBindings(
			{
				...fixture.config,
				outDir: ".",
				clean: true,
			},
			{ baseDir: fixture.root },
		),
		/strict descendant/,
	);

	await assert.rejects(
		generateBindings(
			{
				...fixture.config,
				clean: "yes",
			},
			{ baseDir: fixture.root },
		),
		/clean must be a boolean/,
	);
});

test("rejects invalid adapters and destructive output collisions", async (context) => {
	await context.test("adapter without a default create method", async () => {
		const fixture = await createFixture();
		await writeFile(join(fixture.root, "adapter.js"), "export const value = 1;\n");
		await assert.rejects(
			generateBindings(fixture.config, { baseDir: fixture.root }),
			/must default-export an object with create\(wasm\)/,
		);
	});

	await context.test("copied files with the same destination", async () => {
		const fixture = await createFixture();
		await assert.rejects(
			generateBindings(
				{
					...fixture.config,
					adapterFile: "fixture.wasm",
				},
				{ baseDir: fixture.root },
			),
			/output destination collision between wasmFile and adapterFile/,
		);
	});

	await context.test("source file overwritten by a generated target", async () => {
		const fixture = await createFixture();
		await mkdir(fixture.outDir);
		const adapterSource = join(fixture.outDir, "fixture_node.js");
		await writeFile(adapterSource, "export default { create() { return { format() {} }; } };\n");
		await assert.rejects(
			generateBindings(
				{
					...fixture.config,
					adapter: "pkg/fixture_node.js",
					adapterFile: "copied_binding.js",
					assets: [],
					clean: false,
					targets: ["node"],
				},
				{ baseDir: fixture.root },
			),
			/adapter source collides with generated output target node/,
		);
	});
});

test("rejects non-function adapter API values during generation", async () => {
	const fixture = await createFixture();
	await writeFile(
		join(fixture.root, "adapter.js"),
		`export default {
	create() {
		return { format: "not a function" };
	},
};
`,
	);
	await assert.rejects(
		generateBindings(fixture.config, { baseDir: fixture.root }),
		/formatter adapter API export format must be a function/,
	);
});

test("rejects a non-object or empty adapter API during generation", async (context) => {
	const fixture = await createFixture();
	await writeFile(
		join(fixture.root, "adapter.js"),
		`export default {
	create() {
		return null;
	},
};
`,
	);
	await context.test("non-object", async () => {
		await assert.rejects(
			generateBindings(fixture.config, { baseDir: fixture.root }),
			/create\(wasm\) must return an object/,
		);
	});

	const emptyFixture = await createFixture();
	await writeFile(join(emptyFixture.root, "adapter.js"), "export default { create() { return {}; } };\n");
	await context.test("empty object", async () => {
		await assert.rejects(
			generateBindings(emptyFixture.config, { baseDir: emptyFixture.root }),
			/must expose at least one enumerable function/,
		);
	});
});

test("CLI loads bridge.bindings.mjs by default", async () => {
	const fixture = await createFixture();
	const configPath = join(fixture.root, "bridge.bindings.mjs");
	await writeFile(
		configPath,
		`export default {
	name: "fixture",
	wasm: "fixture.wasm",
	adapter: "adapter.js",
	types: { main: "fixture.d.ts" },
	outDir: "cli-pkg",
	clean: true,
	targets: ["node"],
};
`,
	);

	const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
	const { stdout } = await execFileAsync(process.execPath, [cli], {
		cwd: fixture.root,
	});
	assert.match(stdout, /Generated 7 Bridge binding files/);
	const generated = await import(pathToFileURL(join(fixture.root, "cli-pkg", "fixture_node.js")));
	assert.equal(generated.format("cli"), "CLI");
});

/**
 * @param {{ imports?: boolean, omit?: string, endpoint?: boolean }} [options]
 */
async function createFixture(options = {}) {
	const root = await mkdtemp(join(tmpdir(), "wasm-fmt-bindgen-"));
	await mkdir(join(root, "node_modules/@wasm-fmt"), { recursive: true });
	await symlink(
		fileURLToPath(new URL("../../runtime", import.meta.url)),
		join(root, "node_modules/@wasm-fmt/runtime"),
	);
	const wasm = createWasm(options);
	await writeFile(join(root, "fixture.wasm"), wasm);
	await writeFile(
		join(root, "adapter.js"),
		`// @ts-check

let factoryCalls = 0;
let lastFormat;
/** @type {import("@wasm-fmt/runtime").FormatterAdapter<typeof import("./fixture.d.ts")>} */
const adapter = {
	create() {
		factoryCalls += 1;
		lastFormat = function format(source) {
			return source.toUpperCase();
		};
		return { format: lastFormat };
	},
};
export default adapter;
export function getFactoryCalls() {
	return factoryCalls;
}
export function getLastFormat() {
	return lastFormat;
}
`,
	);
	await writeFile(join(root, "fixture.d.ts"), "export declare function format(source: string): string;\n");
	await writeFile(join(root, "NOTICE"), "fixture asset");

	return {
		root,
		outDir: join(root, "pkg"),
		wasm,
		config: {
			name: "fixture",
			wasm: "fixture.wasm",
			adapter: "adapter.js",
			types: {
				main: "fixture.d.ts",
			},
			assets: ["NOTICE"],
			outDir: "pkg",
			clean: true,
		},
	};
}

/**
 * @param {{ imports?: boolean, omit?: string, endpoint?: boolean }} options
 */
function createWasm(options) {
	const core = [
		"wasm_fmt_abi_version",
		"wasm_fmt_alloc",
		"wasm_fmt_reset",
		"wasm_fmt_register_config",
		"wasm_fmt_release_config",
		"wasm_fmt_output",
		"wasm_fmt_error",
	];
	const functions = core.filter((name) => name !== options.omit);
	if (options.endpoint !== false) {
		functions.push("wasm_fmt_format");
	}
	functions.push("_initialize");

	const bytes = [
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...section(
			1,
			vector([
				[0x60, 0x00, 0x00],
				[0x60, 2, 127, 127, 1, 127],
				[0x60, 0, 1, 127],
				[0x60, 2, 127, 127, 0],
				[0x60, 1, 127, 1, 127],
				[0x60, 3, 127, 127, 127, 1, 127],
				[0x60, 1, 127, 0],
			]),
		),
	];

	const importedFunctions = options.hostImports ? 3 : options.imports === true ? 1 : 0;
	if (options.hostImports) {
		bytes.push(
			...section(
				2,
				vector(
					["format_embedded", "embedded_result_len", "read_embedded_result"].map((name, index) => [
						...nameBytes("wasm_fmt_host"),
						...nameBytes(name),
						0,
						options.badSignature ? 0 : index + 1,
					]),
				),
			),
		);
	}
	if (options.imports === true) {
		const importedFunction = [...nameBytes("env"), ...nameBytes("host"), 0x00, 0x00];
		bytes.push(...section(2, vector([importedFunction])));
	}

	const signatureTypes = {
		wasm_fmt_abi_version: 2,
		wasm_fmt_alloc: 4,
		wasm_fmt_reset: 0,
		wasm_fmt_register_config: 5,
		wasm_fmt_release_config: 6,
		wasm_fmt_output: 2,
		wasm_fmt_error: 2,
		wasm_fmt_format: 1,
		_initialize: 0,
	};
	const typeOf = (name) => (name === options.badExport ? (signatureTypes[name] === 0 ? 2 : 0) : signatureTypes[name]);
	bytes.push(...section(3, vector(functions.map((name) => [typeOf(name)]))));
	bytes.push(...section(5, vector([[0x00, 0x01]])));

	const exported = [
		[...nameBytes("memory"), 0x02, 0x00],
		...functions.map((name, index) => [...nameBytes(name), 0x00, ...encodeU32(index + importedFunctions)]),
	];
	bytes.push(...section(7, vector(exported)));

	const bodies = functions.map((name) => {
		const type = typeOf(name);
		const returnsValue = [1, 2, 4, 5].includes(type);
		const body = [0, ...(returnsValue ? [0x41, name === "wasm_fmt_abi_version" ? 1 : 0] : []), 0x0b];
		return [...encodeU32(body.length), ...body];
	});
	bytes.push(...section(10, vector(bodies)));
	return Uint8Array.from(bytes);
}

/**
 * @param {number} id
 * @param {number[]} payload
 */
function section(id, payload) {
	return [id, ...encodeU32(payload.length), ...payload];
}

/**
 * @param {number[][]} values
 */
function vector(values) {
	return [...encodeU32(values.length), ...values.flat()];
}

/**
 * @param {string} value
 */
function nameBytes(value) {
	const bytes = new TextEncoder().encode(value);
	return [...encodeU32(bytes.length), ...bytes];
}

/**
 * @param {number} value
 */
function encodeU32(value) {
	const bytes = [];
	let remaining = value >>> 0;
	do {
		let byte = remaining & 0x7f;
		remaining >>>= 7;
		if (remaining !== 0) {
			byte |= 0x80;
		}
		bytes.push(byte);
	} while (remaining !== 0);
	return bytes;
}

for (const target of ["web", "vite"]) {
	test(`${target} shares initialization, rejects sync races, and retries failures`, async () => {
		const fixture = await createFixture();
		await generateBindings(fixture.config, { baseDir: fixture.root });
		const url = pathToFileURL(await realpath(join(fixture.outDir, `fixture_${target}.js`)));
		const loaderPath = join(fixture.outDir, "vite-loader.js");
		await writeFile(
			loaderPath,
			`
let input;
export function setInput(value) { input = value; }
export default async function load() {
	const bytes = await input;
	return new WebAssembly.Instance(new WebAssembly.Module(bytes));
}
`,
		);
		const loaderUrl = pathToFileURL(await realpath(loaderPath));
		const loader = await import(loaderUrl);
		// Exercise the generated Vite module with the documented ?init contract.
		const hook = registerHooks({
			resolve(specifier, context, nextResolve) {
				if (context.parentURL === url.href && specifier === "./fixture.wasm?init") {
					return { url: loaderUrl.href, shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
		});
		try {
			const module = await import(url);
			const start = (input) => {
				if (target === "web") return module.default(input);
				loader.setInput(input);
				return module.default();
			};
			await assert.rejects(start(new Uint8Array()), WebAssembly.CompileError);
			assert.throws(() => module.format("before"), /not been initialized/);
			const deferred = Promise.withResolvers();
			const first = start(deferred.promise);
			const second = target === "web" ? module.default(fixture.wasm) : module.default();
			assert.equal(first, second);
			assert.throws(() => module.initSync(fixture.wasm), /already in progress/);
			deferred.resolve(fixture.wasm);
			const wasm = await first;
			assert.equal(await second, wasm);
			assert.equal(module.initSync(fixture.wasm), wasm);
			assert.equal(await module.default(), wasm);
			assert.equal(module.format("ready"), "READY");
			const adapter = await import(pathToFileURL(join(fixture.outDir, "fixture_binding.js")));
			assert.equal(adapter.getFactoryCalls(), 1);
			if (target === "vite") {
				await assert.rejects(module.default(fixture.wasm), /takes no arguments/);
				const types = await readFile(join(fixture.outDir, "fixture_vite.d.ts"), "utf8");
				assert.match(types, /initAsync\(\): Promise<InitOutput>/);
				assert.doesNotMatch(types, /input\?:/);
			}
		} finally {
			hook.deregister();
		}
	});
}

test("rejects symlink output ancestors and files before cleaning or overwriting", async () => {
	const fixture = await createFixture();
	const outside = await mkdtemp(join(tmpdir(), "bindgen-external-"));
	await mkdir(join(outside, "pkg"));
	const sentinel = join(outside, "pkg", "sentinel");
	await writeFile(sentinel, "preserve");
	await symlink(outside, join(fixture.root, "alias"));
	await assert.rejects(
		generateBindings({ ...fixture.config, outDir: "alias/pkg" }, { baseDir: fixture.root }),
		/output path must not contain symbolic links/,
	);
	assert.equal(await readFile(sentinel, "utf8"), "preserve");
	await mkdir(fixture.outDir);
	await symlink(sentinel, join(fixture.outDir, "fixture_node.js"));
	await assert.rejects(
		generateBindings({ ...fixture.config, clean: false }, { baseDir: fixture.root }),
		/output path must not contain symbolic links/,
	);
	assert.equal(await readFile(sentinel, "utf8"), "preserve");
});

test("rejects symlinks nested in copied directory assets", async () => {
	const fixture = await createFixture();
	await mkdir(join(fixture.root, "assets"));
	await symlink(join(fixture.root, "NOTICE"), join(fixture.root, "assets", "link"));
	await assert.rejects(
		generateBindings({ ...fixture.config, assets: ["assets"] }, { baseDir: fixture.root }),
		/source assets must not contain symbolic links/,
	);
});

test("rejects unsafe filenames including inferred Wasm filenames before writing", async () => {
	const fixture = await createFixture();
	for (const filename of ['bad"name.wasm', "bad#name.wasm", "bad?name.wasm", "bad\\name.wasm", "bad\nname.wasm"]) {
		for (const field of ["wasmFile", "adapterFile"]) {
			await assert.rejects(
				generateBindings({ ...fixture.config, [field]: filename }, { baseDir: fixture.root }),
				/portable file name/,
			);
		}
		await assert.rejects(
			generateBindings(
				{ ...fixture.config, types: { ...fixture.config.types, mainFile: filename } },
				{ baseDir: fixture.root },
			),
			/portable file name/,
		);
	}
	await assert.rejects(
		generateBindings({ ...fixture.config, wasm: 'bad"name.wasm' }, { baseDir: fixture.root }),
		/portable file name/,
	);
});

test("generated Wasm import entries execute under Node's ESM integration", async () => {
	const fixture = await createFixture();
	await generateBindings(fixture.config, { baseDir: fixture.root });
	for (const file of ["fixture.js", "fixture_esm.js"]) {
		const module = await import(pathToFileURL(join(fixture.outDir, file)));
		assert.equal(module.format("import"), "IMPORT");
	}
});

test("host imports use explicit instances and source-phase bundler loading", async () => {
	const fixture = await createFixture({ hostImports: true });
	await generateBindings(fixture.config, { baseDir: fixture.root });
	const bundler = await readFile(join(fixture.outDir, "fixture.js"), "utf8");
	assert.match(bundler, /import source __bridge_module/);
	assert.doesNotMatch(bundler, /fetch\(/);
	const node = await import(pathToFileURL(join(fixture.outDir, "fixture_node.js")));
	assert.equal(node.format("host"), "HOST");
	const web = await import(pathToFileURL(join(fixture.outDir, "fixture_web.js")));
	await web.default(fixture.wasm);
	assert.equal(web.format("host"), "HOST");
	const invalid = await createFixture({ hostImports: true, badSignature: true });
	await assert.rejects(
		generateBindings(invalid.config, { baseDir: invalid.root }),
		/invalid wasm_fmt_host.* signature/,
	);
});

test("rejects incorrect core, endpoint, and initializer signatures before writing", async () => {
	for (const name of [
		"wasm_fmt_abi_version",
		"wasm_fmt_alloc",
		"wasm_fmt_reset",
		"wasm_fmt_register_config",
		"wasm_fmt_release_config",
		"wasm_fmt_output",
		"wasm_fmt_error",
		"wasm_fmt_format",
		"_initialize",
	]) {
		const fixture = await createFixture({ badExport: name });
		await assert.rejects(
			generateBindings(fixture.config, { baseDir: fixture.root }),
			new RegExp(`invalid ${name} signature`),
		);
		await assert.rejects(readFile(join(fixture.outDir, "fixture_node.js")), { code: "ENOENT" });
	}
});

test("API exports do not shadow loader globals in static or live bindings", async () => {
	const fixture = await createFixture();
	const names = ["WebAssembly", "URL", "Promise", "TypeError", "Object", "fetch", "Response", "Request"];
	await writeFile(
		join(fixture.root, "adapter.js"),
		`export default { create() { return { ${names.map((name) => `${name}: () => ${JSON.stringify(name)}`).join(",")} }; } };`,
	);
	await generateBindings(fixture.config, { baseDir: fixture.root });
	for (const file of ["fixture_node.js", "fixture_esm.js", "fixture.js", "fixture_web.js"]) {
		const api = await import(pathToFileURL(join(fixture.outDir, file)));
		if (api.default) await api.default(fixture.wasm);
		for (const name of names) assert.equal(api[name](), name);
	}
	const { createFormatter } = await import(pathToFileURL(join(fixture.outDir, "fixture_factory.js")));
	const api = createFormatter(fixture.wasm);
	for (const name of names) assert.equal(api[name](), name);
});
