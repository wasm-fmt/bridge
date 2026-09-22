import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createBridgeRuntime } from "../../runtime/src/index.js";

const encoder = new TextEncoder();
const guestNames = ["rust", "go"];
const requiredFunctionExports = [
  "wasm_fmt_abi_version",
  "wasm_fmt_alloc",
  "wasm_fmt_reset",
  "wasm_fmt_register_config",
  "wasm_fmt_release_config",
  "wasm_fmt_format",
  "wasm_fmt_output",
  "wasm_fmt_error",
];

for (const guestName of guestNames) {
  test(`${guestName} guest implements partial updates`, async () => {
    const { runtime } = await loadGuest(guestName);

    assert.equal(runtime.format("alpha beta", "replacement"), "alpha BETA");
    assert.equal(runtime.format("abcd", "insertion"), "abXYcd");
    assert.equal(runtime.format("abcd", "deletion"), "ad");
    assert.equal(runtime.format("abcdef", "multiple"), "AbCDef!");
    assert.equal(runtime.format("ab", "same-position-insertions"), "aXYb");
    assert.equal(runtime.format("same", "empty"), "same");
    assert.equal(runtime.format("a💩b", "unicode"), "a猫b");

    const exports = await loadGuestExports(guestName);
    assert.equal(invokeFormat(exports, "same", "empty"), 2);
    assert.equal(invokeFormat(exports, "same", "unchanged"), 0);
    assert.equal(invokeFormat(exports, "same", "identical-full"), 1);
    assert.equal(invokeFormat(exports, "same", "error"), 3);
    assert.equal(invokeFormat(exports, "a💩b", "invalid-unicode-boundary"), 3);
  });

  test(`${guestName} guest preserves explicit full, unchanged, and error results`, async () => {
    const { runtime } = await loadGuest(guestName);

    assert.equal(runtime.format("MiXeD", "full"), "MIXED");
    assert.equal(runtime.format("same", "identical-full"), "same");
    assert.equal(runtime.format("same", "unchanged"), "same");
    assert.throws(
      () => runtime.format("source", "error"),
      /requested conformance error/,
    );
    assert.throws(
      () => runtime.format("a💩b", "invalid-unicode-boundary"),
      /UTF-8/,
    );
  });

  test(`${guestName} guest implements the complete configuration lifecycle`, async () => {
    const { runtime } = await loadGuest(guestName);

    assert.equal(runtime.format("body", "config"), "body");
    assert.equal(runtime.format("body", "config", "inline:"), "inline:body");

    const handle = runtime.createConfig("registered:");
    assert.equal(runtime.format("body", "config", handle), "registered:body");
    assert.equal(runtime.format("again", "config", handle), "registered:again");
    assert.equal(
      runtime.formatRanges("abcdef", [], handle),
      "registered:ranges:empty",
    );

    runtime.releaseConfig(handle);
    assert.throws(
      () => runtime.format("body", "config", handle),
      /unknown or released config handle/,
    );

    assert.throws(
      () => runtime.createConfig(new Uint8Array([0xff])),
      /config must be valid UTF-8/,
    );
    assert.throws(
      () => runtime.format("body", "config", new Uint8Array([0xff])),
      /config must be valid UTF-8/,
    );

    const exports = await loadGuestExports(guestName);
    const rawConfigId = 41;
    assert.equal(registerConfig(exports, rawConfigId, encoder.encode("raw:")), 1);
    assert.equal(registerConfig(exports, rawConfigId, encoder.encode("replacement:")), 3);
    const request = encodeRequest("body", "config", undefined, rawConfigId);
    const requestPtr = exports.wasm_fmt_alloc(request.length);
    new Uint8Array(exports.memory.buffer, requestPtr, request.length).set(request);
    assert.equal(exports.wasm_fmt_format(requestPtr, request.length), 1);
    const resultPtr = exports.wasm_fmt_output();
    const resultLength = new DataView(exports.memory.buffer).getUint32(resultPtr, true);
    const resultBytes = new Uint8Array(exports.memory.buffer, resultPtr + 4, resultLength);
    assert.equal(new TextDecoder().decode(resultBytes), "raw:body");
    exports.wasm_fmt_reset();
    exports.wasm_fmt_release_config(rawConfigId);
    assert.equal(
      invokeEndpoint(
        exports,
        exports.wasm_fmt_format,
        encodeRequest("body", "config", undefined, rawConfigId),
      ),
      3,
    );
  });

  test(`${guestName} guest reclaims transient memory while retaining live configs`, async () => {
    const { exports, runtime } = await loadGuest(guestName);
    const handle = runtime.createConfig("kept:");
    const source = "a".repeat(65536);
    const expected = "aaXY" + source.slice(2);
    for (let index = 0; index < 256; index++) {
      assert.equal(runtime.format(source, "insertion", handle), expected);
    }
    // A generous ceiling detects an allocator that never reclaims per-call data.
    assert.ok(exports.memory.buffer.byteLength < 16 * 1024 * 1024);
    assert.equal(runtime.format("body", "config", handle), "kept:body");
    runtime.releaseConfig(handle);
  });

  test(`${guestName} guest requires a complete, single-use input allocation`, async () => {
    const exports = await loadGuestExports(guestName);
    const ptr = exports.wasm_fmt_alloc(8);
    assert.throws(() => exports.wasm_fmt_format(ptr + 1, 8), WebAssembly.RuntimeError);

    const emptyGuest = await loadGuestExports(guestName);
    const emptyPtr = emptyGuest.wasm_fmt_alloc(0);
    assert.equal(emptyPtr, 0);
    assert.equal(emptyGuest.wasm_fmt_register_config(1, emptyPtr, 0), 1);
    assert.throws(() => emptyGuest.wasm_fmt_register_config(2, emptyPtr, 0), WebAssembly.RuntimeError);
  });

  test(`${guestName} guest accepts missing, empty, and arbitrary ranges`, async () => {
    const { runtime } = await loadGuest(guestName);

    assert.equal(runtime.formatRanges("abcdef", []), "ranges:empty");
    assert.equal(
      runtime.formatRanges("abcdef", [{ start: 1, end: 4 }]),
      "ranges:one:1-4",
    );
    assert.equal(
      runtime.formatRanges("abcdef", [
        { start: 4, end: 6 },
        { start: 1, end: 5 },
        { start: 1, end: 5 },
        { start: 3, end: 3 },
      ]),
      "ranges:many:4-6,1-5,1-5,3-3",
    );
    assert.equal(
      runtime.formatRanges("a💩b", [
        { start: 1, end: 5 },
        { start: 5, end: 6 },
      ]),
      "ranges:many:1-5,5-6",
    );
    assert.equal(
      runtime.formatRanges(
        "abcdef",
        [{ start: 4, end: 6 }],
        "range-partial",
      ),
      "Xbcdef",
    );
  });

  test(`${guestName} guest rejects malformed range wire payloads`, async () => {
    const exports = await loadGuestExports(guestName);
    const endpoint =
      guestName === "rust"
        ? exports.wasm_fmt_format_range
        : exports.wasm_fmt_format;

    assert.equal(
      invokeEndpoint(
        exports,
        endpoint,
        encodeRequest("abc", undefined, new Uint8Array([1, 0, 0])),
      ),
      3,
    );
    assert.equal(
      invokeEndpoint(
        exports,
        endpoint,
        encodeRequest("abc", undefined, encodeRanges([{ start: 0, end: 4 }])),
      ),
      3,
    );
    assert.equal(
      invokeEndpoint(
        exports,
        endpoint,
        encodeRequest(
          "a💩b",
          undefined,
          encodeRanges([{ start: 2, end: 5 }]),
        ),
      ),
      3,
    );
  });

  if (guestName === "rust") {
    test("Rust guest exposes independent formatter endpoints", async () => {
      const { runtime } = await loadGuest(guestName);

      assert.equal(
        runtime.invoke("format_range", "abcdef", {
          ranges: [{ start: 2, end: 4 }],
        }),
        "ranges:one:2-4",
      );
      assert.throws(
        () => runtime.invoke("format_range", "abcdef"),
        /requires ranges|ranges.*required|required.*ranges/i,
      );
      assert.throws(
        () =>
          runtime.invoke("format", "abcdef", {
            filename: "full",
            ranges: [{ start: 0, end: 1 }],
          }),
        /does not accept ranges|ranges/i,
      );
    });
  }

  test(`${guestName} guest has the complete import-free ABI`, async () => {
    const bytes = await readFile(
      new URL(`../artifacts/${guestName}.wasm`, import.meta.url),
    );
    const module = await WebAssembly.compile(bytes);

    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const moduleExports = WebAssembly.Module.exports(module);
    assert.deepEqual(
      moduleExports.find(({ name }) => name === "memory"),
      { name: "memory", kind: "memory" },
    );
    const expectedExports =
      guestName === "rust"
        ? [...requiredFunctionExports, "wasm_fmt_format_range"]
        : requiredFunctionExports;

    assert.deepEqual(
      moduleExports
        .filter(({ name }) => name.startsWith("wasm_fmt_"))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
      expectedExports
        .map((name) => ({ name, kind: "function" }))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    );
  });
}

async function loadGuestExports(guestName) {
  const bytes = await readFile(
    new URL(`../artifacts/${guestName}.wasm`, import.meta.url),
  );
  const { instance } = await WebAssembly.instantiate(bytes, {});
  instance.exports._initialize?.();

  return instance.exports;
}

async function loadGuest(guestName) {
  const exports = await loadGuestExports(guestName);
  return {
    exports,
    runtime: createBridgeRuntime(exports, {
      encodeConfig: encodeConformanceConfig,
    }),
  };
}

function encodeConformanceConfig(config) {
  if (config instanceof Uint8Array) {
    return config;
  }
  if (typeof config !== "string") {
    throw new TypeError("conformance config must be a string or Uint8Array");
  }
  return encoder.encode(config);
}

function registerConfig(wasm, id, config) {
  const pointer = wasm.wasm_fmt_alloc(config.length);
  new Uint8Array(wasm.memory.buffer, pointer, config.length).set(config);

  try {
    return wasm.wasm_fmt_register_config(id, pointer, config.length);
  } finally {
    wasm.wasm_fmt_reset();
  }
}

function invokeFormat(wasm, source, filename) {
  const request = encodeRequest(source, filename);
  return invokeEndpoint(wasm, wasm.wasm_fmt_format, request);
}

function invokeEndpoint(wasm, endpoint, request) {
  const pointer = wasm.wasm_fmt_alloc(request.length);
  new Uint8Array(wasm.memory.buffer, pointer, request.length).set(request);

  try {
    return endpoint(pointer, request.length);
  } finally {
    wasm.wasm_fmt_reset();
  }
}

function encodeRequest(source, filename, ranges, registeredConfig) {
  const magic = encoder.encode("WASM-FMT");
  const fields = [[1, encoder.encode(source)]];
  if (filename !== undefined) {
    fields.push([2, encoder.encode(filename)]);
  }
  if (registeredConfig !== undefined) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, registeredConfig, true);
    fields.push([4, bytes]);
  }
  if (ranges !== undefined) {
    fields.push([5, ranges]);
  }
  const length = fields.reduce(
    (total, [, value]) => total + 8 + value.length,
    magic.length,
  );
  const request = new Uint8Array(length);
  const view = new DataView(request.buffer);
  request.set(magic);

  let offset = magic.length;
  for (const [tag, value] of fields) {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, 0, true);
    view.setUint32(offset + 4, value.length, true);
    offset += 8;
    request.set(value, offset);
    offset += value.length;
  }

  return request;
}

function encodeRanges(ranges) {
  const payload = new Uint8Array(4 + ranges.length * 8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, ranges.length, true);

  let offset = 4;
  for (const range of ranges) {
    view.setUint32(offset, range.start, true);
    view.setUint32(offset + 4, range.end, true);
    offset += 8;
  }
  return payload;
}
