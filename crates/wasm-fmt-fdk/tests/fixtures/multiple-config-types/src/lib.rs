#[bridge::config]
#[derive(Clone, Default)]
struct First;

#[bridge::config]
#[derive(Clone, Default)]
struct Second;

impl bridge::Config for First {
    fn decode(_bytes: &[u8]) -> bridge::Result<Self> {
        Ok(Self)
    }
}

impl bridge::Config for Second {
    fn decode(_bytes: &[u8]) -> bridge::Result<Self> {
        Ok(Self)
    }
}

#[bridge::formatter]
fn format(source: &str, config: &First) -> String {
    let _ = config;
    source.to_owned()
}
