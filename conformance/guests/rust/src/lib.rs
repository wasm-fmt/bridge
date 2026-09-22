use std::ops::Range;

use bridge::{FormatResult, TextEdit};

#[bridge::config]
#[derive(Default)]
struct Options {
    prefix: String,
}

impl bridge::Config for Options {
    fn decode(bytes: &[u8]) -> bridge::Result<Self> {
        let prefix = std::str::from_utf8(bytes)
            .map_err(|error| format!("config must be valid UTF-8: {error}"))?
            .to_owned();
        Ok(Self { prefix })
    }
}

#[bridge::formatter]
fn format(source: &str, filename: Option<&str>, config: &Options) -> FormatResult {
    match filename {
        Some("config") => FormatResult::FullUpdate(format!("{}{source}", config.prefix)),
        Some("replacement") => partial(vec![edit(6, 10, "BETA")]),
        Some("insertion") => partial(vec![edit(2, 2, "XY")]),
        Some("deletion") => partial(vec![edit(1, 3, "")]),
        Some("multiple") => partial(vec![edit(0, 1, "A"), edit(2, 4, "CD"), edit(6, 6, "!")]),
        Some("same-position-insertions") => partial(vec![edit(1, 1, "X"), edit(1, 1, "Y")]),
        Some("empty") => partial(Vec::new()),
        Some("unicode") => partial(vec![edit(1, 5, "猫")]),
        Some("invalid-unicode-boundary") => partial(vec![edit(2, 5, "x")]),
        Some("unchanged") => FormatResult::Unchanged,
        Some("full") => FormatResult::FullUpdate(source.to_uppercase()),
        Some("identical-full") => FormatResult::FullUpdate(source.to_owned()),
        Some("error") => FormatResult::Error("requested conformance error".to_owned()),
        Some(mode) => FormatResult::Error(format!("unknown conformance mode {mode}")),
        None => FormatResult::Error("a conformance mode filename is required".to_owned()),
    }
}

#[bridge::formatter]
fn format_range(
    source: &str,
    ranges: &[Range<u32>],
    filename: Option<&str>,
    config: &Options,
) -> bridge::Result<FormatResult> {
    if filename == Some("range-partial") {
        return Ok(partial(vec![edit(0, 1, "X")]));
    }

    let _ = source;
    Ok(FormatResult::FullUpdate(format!(
        "{}{}",
        config.prefix,
        describe_ranges(ranges)
    )))
}

fn describe_ranges(ranges: &[Range<u32>]) -> String {
    match ranges {
        [] => "ranges:empty".to_owned(),
        [range] => format!("ranges:one:{}-{}", range.start, range.end),
        ranges => {
            let descriptions = ranges
                .iter()
                .map(|range| format!("{}-{}", range.start, range.end))
                .collect::<Vec<_>>()
                .join(",");
            format!("ranges:many:{descriptions}")
        }
    }
}

fn partial(edits: Vec<TextEdit>) -> FormatResult {
    FormatResult::PartialUpdate(edits)
}

fn edit(start: u32, end: u32, text: &str) -> TextEdit {
    TextEdit {
        range: start..end,
        text: text.to_owned(),
    }
}

#[cfg(feature = "host-formatting")]
#[bridge::formatter]
fn embedded(
    source: &str,
    host: &bridge::Host<'_>,
    config: Option<&Options>,
) -> Result<String, String> {
    let _ = config;
    assert_ne!(source, "__trap", "requested child trap");
    let result = host.format_embedded(bridge::EmbeddedRequest {
        source,
        filename: "embedded.py",
        line_width: std::num::NonZeroU32::new(60),
    })?;
    Ok(result.unwrap_or_else(|| source.to_owned()))
}
