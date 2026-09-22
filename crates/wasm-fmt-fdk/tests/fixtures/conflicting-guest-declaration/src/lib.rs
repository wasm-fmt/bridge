bridge::guest!();

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
    source.to_owned()
}
