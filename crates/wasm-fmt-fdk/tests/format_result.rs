#[bridge::formatter]
fn format(source: &str) -> bridge::FormatResult {
    bridge::FormatResult::PartialUpdate(vec![bridge::TextEdit {
        range: 0..source.len() as u32,
        text: "formatted".to_string(),
    }])
}

#[test]
fn formatter_macro_accepts_a_format_result() {
    let formatted = __bridge_endpoint_format("source", Some("ignored.ext"), None, None);

    assert_eq!(
        formatted,
        bridge::FormatResult::PartialUpdate(vec![bridge::TextEdit {
            range: 0..6,
            text: "formatted".to_string(),
        }])
    );
}
