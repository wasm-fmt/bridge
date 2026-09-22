export interface BridgeExports {
	[name: string]: unknown;
	memory: WebAssembly.Memory;
	wasm_fmt_abi_version(): number;
	wasm_fmt_alloc(size: number): number;
	wasm_fmt_reset(): void;
	wasm_fmt_register_config(id: number, ptr: number, len: number): 1 | 3;
	wasm_fmt_release_config(id: number): void;
	wasm_fmt_format?(ptr: number, len: number): 0 | 1 | 2 | 3;
	wasm_fmt_format_range?(ptr: number, len: number): 0 | 1 | 2 | 3;
	wasm_fmt_output(): number;
	wasm_fmt_error(): number;
}

declare const configHandleBrand: unique symbol;

/** An instance-local registered configuration handle, branded by formatter. */
export type ConfigHandle<Brand extends string = string> = symbol & {
	readonly [configHandleBrand]: Brand;
};

/** Formatter-owned adapter executed once for each instantiated Bridge guest. */
export interface FormatterAdapter<Api extends object> {
	/** Creates the public API bound directly to one instantiated Bridge guest. */
	create(wasm: BridgeExports, host: BridgeHost): Api;
}

export interface TextRange {
	readonly start: number;
	readonly end: number;
}

export interface EmbeddedFormatRequest {
	readonly filename: string;
	readonly source: string;
	readonly lineWidth?: number;
}

export type EmbeddedFormatter = (request: EmbeddedFormatRequest) => string | undefined;

export interface BridgeHost {
	readonly imports: WebAssembly.Imports;
	createRuntime(wasm: BridgeExports, options?: RuntimeOptions): FormatterRuntime;
}

export function createBridgeHost(): BridgeHost;

export interface InvokeOptions {
	readonly onFormatEmbedded?: EmbeddedFormatter;
	readonly filename?: string;
	readonly config?: unknown | symbol;
	readonly ranges?: readonly TextRange[];
}

export interface RuntimeOptions {
	encodeConfig?(config: unknown): Uint8Array;
}

export type FormatConfig = object | symbol;

export interface FormatterRuntime {
	format(source: string, filenameOrConfig?: string | FormatConfig, config?: unknown): string;
	formatRanges(
		source: string,
		ranges: readonly TextRange[],
		filenameOrConfig?: string | FormatConfig,
		config?: unknown,
	): string;
	invoke(endpoint: string, source: string, options?: InvokeOptions): string;
	createConfig(config?: unknown): symbol;
	releaseConfig(handle: symbol): void;
}

/** Exclusively owns the guest; a trap or malformed response permanently retires it. */
export function createBridgeRuntime(wasm: BridgeExports, options?: RuntimeOptions): FormatterRuntime;

export interface ContextFormatRequest extends EmbeddedFormatRequest {
	readonly onFormatEmbedded: EmbeddedFormatter;
}

export interface FormatterRegistration {
	readonly extensions?: readonly string[];
	readonly fileNames?: readonly string[];
	readonly format: (request: ContextFormatRequest) => string;
}

export interface FormatterContext {
	addFormatter(registration: FormatterRegistration): void;
	format(request: EmbeddedFormatRequest): string;
}

export function createFormatterContext(): FormatterContext;
