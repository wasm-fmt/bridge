use std::ops::Range;

#[bridge::config]
#[derive(Clone, Default)]
struct Options {
    prefix: String,
}

impl bridge::Config for Options {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        let prefix = std::str::from_utf8(bytes)
            .map_err(|error| error.to_string())?
            .to_string();
        Ok(Self { prefix })
    }
}

#[bridge::formatter]
fn format(source: &str, config: &Options) -> String {
    format!("{}{source}", config.prefix)
}

#[bridge::formatter]
fn format_range(ranges: &[Range<u32>], source: &str, config: &Options) -> bridge::FormatResult {
    let text = format!("{}{}", config.prefix, ranges.len());
    bridge::FormatResult::FullUpdate(format!("{source}:{text}"))
}

#[bridge::formatter]
fn flexible_format(source: &str, ranges: Option<&[Range<u32>]>) -> String {
    let range_count = ranges.map_or_else(|| "none".to_string(), |ranges| ranges.len().to_string());
    format!("{source}:{range_count}")
}

#[bridge::formatter]
fn optional_config(source: &str, config: Option<&Options>) -> String {
    let prefix = config.map_or("", |config| config.prefix.as_str());
    format!("{prefix}{source}")
}

#[test]
fn multiple_formatter_endpoints_can_coexist() {
    let config = Options {
        prefix: "prefix:".to_string(),
    };

    assert_eq!(
        __bridge_endpoint_format("source", None, Some(&config), None),
        bridge::FormatResult::FullUpdate("prefix:source".to_string())
    );
    assert_eq!(
        __bridge_endpoint_format_range("source", None, Some(&config), Some(&[0..3, 5..6])),
        bridge::FormatResult::FullUpdate("source:prefix:2".to_string())
    );
}

#[test]
fn optional_ranges_preserve_absent_and_present_empty() {
    assert_eq!(
        __bridge_endpoint_flexible_format("source", None, None, None),
        bridge::FormatResult::FullUpdate("source:none".to_string())
    );
    assert_eq!(
        __bridge_endpoint_flexible_format("source", None, None, Some(&[])),
        bridge::FormatResult::FullUpdate("source:0".to_string())
    );
}

#[test]
fn optional_config_preserves_absent_and_present() {
    let config = Options {
        prefix: "prefix:".to_string(),
    };

    assert_eq!(
        __bridge_endpoint_optional_config("source", None, None, None),
        bridge::FormatResult::FullUpdate("source".to_string())
    );
    assert_eq!(
        __bridge_endpoint_optional_config("source", None, Some(&config), None),
        bridge::FormatResult::FullUpdate("prefix:source".to_string())
    );
}
