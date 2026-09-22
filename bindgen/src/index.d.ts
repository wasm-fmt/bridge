export type BindingsTarget = "bundler" | "node" | "esm" | "web" | "vite";

export interface BindingsAsset {
	/** Input path, resolved relative to the configuration file. */
	from: string;
	/** Relative destination below `outDir`; defaults to the input basename. */
	to?: string;
}

/** Build-time inputs for generating a formatter's JavaScript package shell. */
export interface BindingsConfig {
	/** Safe identifier used as the generated entry-point filename prefix. */
	name: string;
	/** Compiled Bridge guest input path. */
	wasm: string;
	/** Copied Wasm filename; defaults to the input basename. */
	wasmFile?: string;
	/** Module whose default export is a formatter adapter. */
	adapter: string;
	/** Copied adapter filename; defaults to `<name>_binding.js`. */
	adapterFile?: string;
	types: {
		/** Formatter-owned public declarations copied into the output. */
		main: string;
		/** Copied declaration filename; defaults to `<name>.d.ts`. */
		mainFile?: string;
	};
	/** Output directory within the configuration directory; symbolic links are rejected. */
	outDir?: string;
	/** Additional package files or directories to copy; must not contain symbolic links. */
	assets?: readonly (string | BindingsAsset)[];
	/** Remove `outDir` before writing; defaults to false. */
	clean?: boolean;
	/** Entry-point variants to generate; defaults to every supported target. */
	targets?: readonly BindingsTarget[];
	/** Guest initializer policy; `"auto"` calls `_initialize` when exported. */
	initialize?: "auto" | false | string;
}

export interface GenerateBindingsOptions {
	/** Base directory for relative descriptor paths; defaults to `process.cwd()`. */
	baseDir?: string;
}

export interface GenerateBindingsResult {
	/** Absolute output directory. */
	outDir: string;
	/** Absolute paths copied or generated during this call. */
	files: readonly string[];
	/** Inspected `wasm_fmt_*` formatter endpoint exports. */
	endpoints: readonly string[];
	/** Public function exports discovered from the formatter adapter. */
	exports: readonly string[];
	/** Initializer selected for generated entry points, if any. */
	initialize?: string;
	/** Whether the guest imports the embedded-formatting host group. */
	hostImports: boolean;
}

/** Provides inference for a descriptor without performing runtime work. */
export declare function defineBindings<const T extends BindingsConfig>(config: T): T;

/** Inspects inputs and writes static JavaScript bindings. */
export declare function generateBindings(
	config: BindingsConfig,
	options?: GenerateBindingsOptions,
): Promise<GenerateBindingsResult>;
