use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[test]
fn guest_build_contract() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixtures_manifest = manifest_dir.join("tests/fixtures/Cargo.toml");
    let target_dir = env::temp_dir().join(format!(
        "wasm-fmt-fdk-guest-contract-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&target_dir);

    for package in [
        "bridge-fixture-multiple-config-types",
        "bridge-fixture-undeclared-endpoint-config",
        "bridge-fixture-conflicting-guest-declaration",
    ] {
        let output = build_fixture(&fixtures_manifest, &target_dir, package);
        assert_build_result(package, output, false);
    }

    let _ = fs::remove_dir_all(target_dir);
}

fn build_fixture(manifest: &Path, target_dir: &Path, package: &str) -> Output {
    let cargo = env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    Command::new(cargo)
        .args([
            "build",
            "--offline",
            "--locked",
            "--target",
            "wasm32-unknown-unknown",
            "--package",
            package,
            "--manifest-path",
        ])
        .arg(manifest)
        .arg("--target-dir")
        .arg(target_dir)
        .env("CARGO_TERM_COLOR", "never")
        .output()
        .expect("failed to run Cargo for a guest contract fixture")
}

fn assert_build_result(package: &str, output: Output, expected_success: bool) {
    if output.status.success() == expected_success {
        return;
    }

    panic!(
        "unexpected build result for {package}\nstatus: {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
