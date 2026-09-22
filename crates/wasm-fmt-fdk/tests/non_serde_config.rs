#[bridge::config]
#[derive(Clone, Default, Debug, Eq, PartialEq)]
struct RawConfig(Vec<u8>);

impl bridge::Config for RawConfig {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        Ok(Self(bytes.to_vec()))
    }
}

#[bridge::formatter]
fn format(config: &RawConfig, filename: Option<&str>, source: &str) -> Result<String, String> {
    Ok(format!(
        "{source}:{}:{}",
        config.0.len(),
        filename.unwrap_or_default()
    ))
}

#[test]
fn formatter_macro_accepts_a_non_serde_config() {
    let config = <RawConfig as bridge::Config>::decode(&[0xff, 0x00]).unwrap();
    let formatted = __bridge_endpoint_format("source", Some("file.ext"), Some(&config), None);

    assert_eq!(
        formatted,
        bridge::FormatResult::FullUpdate("source:2:file.ext".to_string())
    );
}
