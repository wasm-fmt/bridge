export { generateBindings } from "./generate.js";

/**
 * Provides editor inference for a bindings configuration without changing it.
 *
 * This function is only used while loading the build-time configuration. It
 * does not participate in formatter execution.
 *
 * @template {import("./index.js").BindingsConfig} T
 * @param {T} config
 * @returns {T}
 */
export function defineBindings(config) {
	return config;
}
