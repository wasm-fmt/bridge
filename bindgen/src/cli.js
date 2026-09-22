#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBindings } from "./generate.js";

const configPath = resolve(process.cwd(), readConfigPath(process.argv.slice(2)));
const configModule = await import(pathToFileURL(configPath).href);

if (configModule.default === undefined) {
	throw new Error(`${configPath} must have a default export`);
}

const result = await generateBindings(configModule.default, {
	baseDir: dirname(configPath),
});

console.log(`Generated ${result.files.length} Bridge binding files in ${result.outDir}`);

/**
 * @param {string[]} args
 */
function readConfigPath(args) {
	let configPath = "bridge.bindings.mjs";

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--config") {
			const value = args[index + 1];
			if (value === undefined) {
				throw new Error("--config requires a path");
			}
			configPath = value;
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			console.log("Usage: wasm-fmt-bindgen [--config bridge.bindings.mjs]");
			process.exit(0);
		}

		throw new Error(`unknown argument: ${argument}`);
	}

	return configPath;
}
