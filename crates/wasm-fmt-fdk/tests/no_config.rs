#[bridge::formatter]
fn format(source: &str) -> String {
    source.to_uppercase()
}

#[test]
fn formatter_macro_accepts_a_source_only_function() {
    let formatted = __bridge_endpoint_format("source", Some("ignored.ext"), None, None);

    assert_eq!(
        formatted,
        bridge::FormatResult::FullUpdate("SOURCE".to_string())
    );
}
