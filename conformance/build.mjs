import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const conformanceDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(conformanceDirectory, "..");
const artifactsDirectory = resolve(conformanceDirectory, "artifacts");
const goGuestDirectory = resolve(conformanceDirectory, "guests/go");

mkdirSync(artifactsDirectory, { recursive: true });

run(
  "cargo",
  [
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "-p",
    "bridge-conformance-rust",
  ],
  rootDirectory,
);

copyFileSync(
  resolve(
    rootDirectory,
    "target/wasm32-unknown-unknown/release/bridge_conformance_rust.wasm",
  ),
  resolve(artifactsDirectory, "rust.wasm"),
);

run(
  "mise",
  [
    "exec",
    "--",
    "tinygo",
    "build",
    "-o",
    resolve(artifactsDirectory, "go.wasm"),
    "-target=wasm-unknown",
    "-gc=conservative",
    "-no-debug",
    ".",
  ],
  goGuestDirectory,
);

run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "bridge-conformance-rust", "--features", "host-formatting"], rootDirectory);
copyFileSync(resolve(rootDirectory, "target/wasm32-unknown-unknown/release/bridge_conformance_rust.wasm"), resolve(artifactsDirectory, "rust-host.wasm"));
run("mise", ["exec", "--", "tinygo", "build", "-o", resolve(artifactsDirectory, "go-host.wasm"), "-target=wasm-unknown", "-gc=conservative", "-no-debug", "-tags=bridge_host", "."], goGuestDirectory);

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}
