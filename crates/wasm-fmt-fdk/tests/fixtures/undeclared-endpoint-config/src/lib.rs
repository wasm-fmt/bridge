#[bridge::config]
#[derive(Clone, Default)]
struct Declared;

#[derive(Clone, Default)]
struct Undeclared;

impl bridge::Config for Declared {
    fn decode(_bytes: &[u8]) -> bridge::Result<Self> {
        Ok(Self)
    }
}

impl bridge::Config for Undeclared {
    fn decode(_bytes: &[u8]) -> bridge::Result<Self> {
        Ok(Self)
    }
}

#[bridge::formatter]
fn format(source: &str, config: &Undeclared) -> String {
    let _ = config;
    source.to_owned()
}
