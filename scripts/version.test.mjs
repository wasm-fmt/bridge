import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planVersion } from "./version.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("coordinated bump preserves external dependencies and private fixture versions", () => {
	const plan = planVersion(read, "1.2.3-rc.1");
	assert.equal(plan.changes.size, 7);
	const updated = (path) => plan.changes.get(path) ?? read(path);
	assert.equal(planVersion(updated).current, "1.2.3-rc.1");
	assert.equal(JSON.parse(updated("bindgen/package.json")).dependencies["@wasm-fmt/runtime"], "1.2.3-rc.1");
	assert.match(updated("crates/wasm-fmt-fdk/Cargo.toml"), /version = "=1.2.3-rc.1"/);
	assert.match(updated("conformance/guests/go/go.mod"), /fdk-go v1.2.3-rc.1/);
	for (const path of ["Cargo.lock", "crates/wasm-fmt-fdk/tests/fixtures/Cargo.lock"]) {
		const unrelated = (text) => text.split("[[package]]").filter((block) =>
			!/^\s*name = "(?:wasm-fmt-fdk|wasm-fmt-fdk-macros|bridge-conformance-rust)"/.test(block));
		assert.deepEqual(unrelated(updated(path)), unrelated(read(path)));
	}
	assert.equal(updated("conformance/package.json"), read("conformance/package.json"));
	assert.equal(updated("crates/wasm-fmt-fdk/tests/fixtures/Cargo.toml"), read("crates/wasm-fmt-fdk/tests/fixtures/Cargo.toml"));
});

test("major/minor/patch reset the lower components", () => {
	const initial = planVersion(read, "0.3.7");
	const updated = (path) => initial.changes.get(path) ?? read(path);
	for (const [request, expected] of [["major", "1.0.0"], ["minor", "0.4.0"], ["patch", "0.3.8"]]) {
		assert.equal(planVersion(updated, request).next, expected);
	}
});

test("reject unsupported versions and inconsistent files before producing an edit plan", () => {
	for (const version of ["v1.0.0", "01.0.0", "1.0", "1.0.0-01", "1.0.0+build", "2.0.0", "--unknown"]) {
		assert.throws(() => planVersion(read, version));
	}
	for (const path of planVersion(read).changes.keys()) {
		if (path === "Cargo.toml") continue;
		// Replace the actual current version so this test also works after a release bump.
		const current = planVersion(read).current;
		const drifted = (file) => file === path ? read(file).replaceAll(current, "9.9.9") : read(file);
		assert.throws(() => planVersion(drifted, "1.2.3"), /differs|expected/);
	}
});
