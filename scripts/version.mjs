import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

function replaceOne(text, pattern, value, label) {
	let count = 0;
	const result = text.replace(pattern, (...args) => {
		count++;
		return value(...args);
	});
	if (count !== 1) throw new Error(`${label}: expected exactly one version, found ${count}`);
	return result;
}

export function planVersion(read, requested) {
	const manifest = read("Cargo.toml");
	const workspace = /\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/;
	const section = manifest.match(workspace)?.[1];
	const current = section?.match(/^version = "([^"]+)"$/m)?.[1];
	if (!current) throw new Error("Cargo.toml: missing workspace version");
	let next = requested ?? current;
	if (["major", "minor", "patch"].includes(next)) {
		if (!/^\d+\.\d+\.\d+$/.test(current)) {
			throw new Error("Use an explicit version when leaving a prerelease");
		}
		const parts = current.split(".").map(BigInt);
		const index = ["major", "minor", "patch"].indexOf(next);
		parts[index]++;
		for (let i = index + 1; i < parts.length; i++) parts[i] = 0n;
		next = parts.join(".");
	}
	// Shared Cargo/npm/Go version subset: no build metadata or leading zeroes.
	const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
	const parsed = next.match(semver);
	if (!parsed) throw new Error(`Invalid version: ${next}`);
	if (BigInt(parsed[1]) >= 2n) {
		throw new Error("Go v2+ requires a module/import-path migration; perform that migration before bumping the coordinated version");
	}
	const changes = new Map();
	function edit(path, pattern) {
		const original = changes.get(path) ?? read(path);
		const updated = replaceOne(original, pattern, (match, before, version, after) => {
			if (version !== current) throw new Error(`${path}: ${version} differs from workspace ${current}`);
			return before + next + after;
		}, path);
		changes.set(path, updated);
	}
	changes.set("Cargo.toml", manifest.replace(workspace, (block) =>
		replaceOne(block, /(^version = ")([^"]+)("$)/gm, (_match, before, _version, after) => before + next + after, "Cargo.toml")));
	for (const path of ["runtime/package.json", "bindgen/package.json"]) {
		JSON.parse(read(path));
		edit(path, /(^\s*"version": ")([^"]+)(",?$)/gm);
	}
	edit("bindgen/package.json", /(^\s*"@wasm-fmt\/runtime": ")([^"]+)(",?$)/gm);
	edit("crates/wasm-fmt-fdk/Cargo.toml", /(^wasm-fmt-fdk-macros = \{ version = "=)([^"]+)(".*$)/gm);
	edit("conformance/guests/go/go.mod", /(^require github\.com\/wasm-fmt\/bridge\/fdk-go v)(\S+)($)/gm);
	for (const path of ["Cargo.lock", "crates/wasm-fmt-fdk/tests/fixtures/Cargo.lock"]) {
		let content = read(path);
		const names = ["wasm-fmt-fdk", "wasm-fmt-fdk-macros"];
		if (path === "Cargo.lock") names.push("bridge-conformance-rust");
		for (const name of names) {
			const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")([^"\\n]+)(")`, "g");
			content = replaceOne(content, pattern, (_match, before, version, after) => {
				if (version !== current) throw new Error(`${path}: ${name} is ${version}, expected ${current}`);
				return before + next + after;
			}, `${path}: ${name}`);
		}
		changes.set(path, content);
	}
	return { current, next, changes };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		const dryRun = args.includes("--dry-run");
		const positional = args.filter((arg) => arg !== "--dry-run");
		if (positional.length !== 1) throw new Error("Usage: mise run version <major|minor|patch|X.Y.Z[-prerelease]> [--dry-run]; mise run version:check");
		const check = positional[0] === "--check";
		const plan = planVersion(read, check ? undefined : positional[0]);
		if (check) {
			console.log(`All release versions agree: ${plan.current}`);
		} else {
			if (plan.current === plan.next) throw new Error(`Version is already ${plan.current}`);
			console.log(`${plan.current} -> ${plan.next}${dryRun ? " (dry run)" : ""}`);
			for (const [path, content] of plan.changes) {
				if (!dryRun) writeFileSync(new URL(path, root), content);
				console.log(`  ${path}`);
			}
			console.log("Review CHANGELOG.md and release-status documentation before committing. No commit, tag, or publish was performed.");
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
