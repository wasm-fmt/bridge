import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateBindings } from "../../bindgen/src/index.js";
import test from "node:test";
import { createBridgeHost, createFormatterContext } from "../../runtime/src/index.js";

async function load(name) {
	const host = createBridgeHost();
	const bytes = await readFile(new URL(`../artifacts/${name}-host.wasm`, import.meta.url));
	const module = new WebAssembly.Module(bytes);
	assert.deepEqual(WebAssembly.Module.imports(module).map((x) => x.name).sort(), [
		"embedded_result_len",
		"format_embedded",
		"read_embedded_result",
	]);
	const wasm = new WebAssembly.Instance(module, host.imports).exports;
	wasm._initialize?.();
	const runtime = host.createRuntime(wasm, { encodeConfig: (x) => new TextEncoder().encode(x) });
	const invoke = (source, onFormatEmbedded, config) =>
		runtime.invoke(name === "rust" ? "embedded" : "format", source, { filename: "embedded", onFormatEmbedded, config });
	return { runtime, wasm, invoke };
}

for (const name of ["rust", "go"]) {
	test(`${name} host transfer preserves UTF-8, skip, empty results and configuration`, async () => {
		const { invoke, runtime } = await load(name);
		const handle = runtime.createConfig("prefix");
		let seen;
		assert.equal(
			invoke("猫😀", (request) => {
				seen = request;
				return "\ufeff" + request.source;
			}, handle),
			"\ufeff猫😀",
		);
		assert.deepEqual(seen, { source: "猫😀", filename: "embedded.py", lineWidth: 60 });
		assert.equal(invoke("original"), "original");
		assert.equal(invoke("original", () => undefined), "original");
		assert.equal(invoke("original", () => ""), "");
		runtime.releaseConfig(handle);
		assert.throws(() => invoke("x", () => "y", handle), /unknown or released/);
	});
	test(`${name} callback errors are recoverable and cycles rejected`, async () => {
		const { invoke } = await load(name);
		for (
			const callback of [
				() => {
					throw new Error("child error");
				},
				() => Promise.resolve("x"),
			() => Promise.reject(new Error("async rejected")),
				() => 42,
				() => "\ud800",
				() => {
					throw {
						toString() {
							throw 1;
						},
					};
				},
				() => invoke("nested"),
			]
		) {
			assert.throws(() => invoke("x", callback));
			assert.equal(invoke("x", () => "recovered"), "recovered");
		}
	});
	test(`${name} host transfer handles memory growth and repeated results`, async () => {
		const { invoke, wasm } = await load(name);
		const large = "猫".repeat(100000);
		assert.equal(invoke("x", () => large), large);
		for (let i = 0; i < 100; i++) assert.equal(invoke("x", () => large), large);
		const baseline = wasm.memory.buffer.byteLength;
		for (let i = 0; i < 100; i++) assert.equal(invoke("x", () => large), large);
		assert.ok(wasm.memory.buffer.byteLength <= baseline);
	});
}

test("context composes Rust and Go instances and rejects indirect cycles", async () => {
	const a = await load("rust");
	const b = await load("go");
	const context = createFormatterContext();
	context.addFormatter({
		extensions: ["md"],
		format: ({ source, onFormatEmbedded }) => a.invoke(source, onFormatEmbedded),
	});
	context.addFormatter({ extensions: ["py"], format: ({ source }) => b.runtime.format(source, "full") });
	assert.equal(context.format({ filename: "README.md", source: "hello" }), "HELLO");
	assert.equal(context.format({ filename: "x.py", source: "world" }), "WORLD");
	const cycle = () => a.invoke("x", () => b.invoke("x", () => a.invoke("x")));
	assert.throws(cycle, /reentrant/);
	assert.equal(a.invoke("ok"), "ok");
	assert.equal(b.invoke("ok"), "ok");
});

test("a child trap retires the child but the parent remains reusable", async () => {
	const parent = await load("rust");
	const child = await load("go");
	assert.throws(() => parent.invoke("x", () => child.invoke("__trap")));
	assert.throws(() => child.invoke("x"), /unusable/);
	assert.equal(parent.invoke("recovered", () => "ok"), "ok");
});


for (const name of ["rust", "go"]) {
	test(`${name} generated factories isolate configs and recover from a trapped instance`, async () => {
		const root = await mkdtemp(join(tmpdir(), "bridge-factory-"));
		await mkdir(join(root, "node_modules/@wasm-fmt"), { recursive: true });
		await symlink(fileURLToPath(new URL("../../runtime", import.meta.url)), join(root, "node_modules/@wasm-fmt/runtime"));
		await writeFile(join(root, "package.json"), '{"type":"module"}');
		await writeFile(join(root, "api.d.ts"), "export declare function format(source: string, config?: symbol): string; export declare function createConfig(value: string): symbol;");
		await writeFile(join(root, "adapter.js"), `export default {
			create(wasm, host) {
				const runtime = host.createRuntime(wasm, { encodeConfig: value => new TextEncoder().encode(value) });
				return {
					format: (source, config) => runtime.invoke("${name === "rust" ? "embedded" : "format"}", source, { filename: "embedded", config }),
					createConfig: value => runtime.createConfig(value),
				};
			}
		};`);
		const wasm = fileURLToPath(new URL(`../artifacts/${name}-host.wasm`, import.meta.url));
		await generateBindings({ name: "fixture", wasm, adapter: "adapter.js", types: { main: "api.d.ts" }, targets: ["node"] }, { baseDir: root });
		const { createFormatter } = await import(pathToFileURL(join(root, "pkg/fixture_factory.js")));
		const bytes = await readFile(wasm);
		const module = new WebAssembly.Module(bytes);
		const first = createFormatter(module);
		const second = createFormatter(bytes);
		const handle = first.createConfig("prefix");
		assert.equal(first.format("first", handle), "first");
		assert.throws(() => second.format("foreign", handle), /unknown or released config handle/);
		assert.throws(() => first.format("__trap"), WebAssembly.RuntimeError);
		assert.throws(() => first.format("after"), /unusable/);
		assert.equal(second.format("unaffected"), "unaffected");
		const replacement = createFormatter(module);
		assert.equal(replacement.format("recovered"), "recovered");
	});
}
