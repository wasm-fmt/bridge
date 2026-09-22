#[bridge::config]
struct OptionalConfig;

impl bridge::Config for OptionalConfig {
    fn decode(_bytes: &[u8]) -> bridge::Result<Self> {
        Ok(Self)
    }
}

#[bridge::formatter]
fn format(source: &str, config: Option<&OptionalConfig>) -> String {
    let _ = config;
    source.to_owned()
}

#[test]
fn optional_config_does_not_require_default() {
    assert_eq!(format("source", None), "source");
}
