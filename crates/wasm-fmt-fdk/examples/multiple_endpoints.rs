use std::ops::Range;

#[bridge::config]
#[derive(Clone, Default)]
struct Options;

impl bridge::Config for Options {
    fn decode(_bytes: &[u8]) -> bridge::Result<Self> {
        Ok(Self)
    }
}

#[bridge::formatter]
fn format(source: &str, config: &Options) -> String {
    let _ = config;
    source.to_string()
}

#[bridge::formatter]
fn format_range(
    source: &str,
    ranges: &[Range<u32>],
    config: Option<&Options>,
) -> bridge::Result<String> {
    let _ = (ranges, config);
    Ok(source.to_string())
}

fn main() {}
