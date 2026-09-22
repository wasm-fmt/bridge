//! Call-scoped access to synchronous embedded formatting.

use std::{marker::PhantomData, num::NonZeroU32};

/// A fragment and virtual filename to be formatted by the host.
pub struct EmbeddedRequest<'a> {
    pub source: &'a str,
    pub filename: &'a str,
    pub line_width: Option<NonZeroU32>,
}

/// Host access borrowed only for the current formatter invocation.
///
/// Obtain this through a `host: &bridge::Host<'_>` formatter parameter.
/// This capability is not available to configuration decoders.
pub struct Host<'call> {
    _call: PhantomData<&'call mut ()>,
    _not_send: PhantomData<*mut ()>,
}

impl<'call> Host<'call> {
    /// Used only by generated formatter endpoint bodies.
    ///
    /// # Safety
    /// The caller must be executing a formatter body after decoding its request
    /// and configuration. The capability must not outlive that invocation.
    #[doc(hidden)]
    pub unsafe fn __for_call(_source: &'call str) -> Self {
        Self {
            _call: PhantomData,
            _not_send: PhantomData,
        }
    }

    /// Returns None when the host declines to replace the fragment.
    #[cfg(feature = "host-formatting")]
    pub fn format_embedded(&self, request: EmbeddedRequest<'_>) -> Result<Option<String>, String> {
        let bytes = encode_request(request)?;
        exchange(&bytes)
    }
}

#[cfg(feature = "host-formatting")]
fn encode_request(request: EmbeddedRequest<'_>) -> Result<Vec<u8>, String> {
    if request.filename.is_empty() {
        return Err("embedded filename must not be empty".into());
    }
    let mut length = 24usize;
    for size in [
        request.source.len(),
        request.filename.len(),
        if request.line_width.is_some() { 12 } else { 0 },
    ] {
        length = length
            .checked_add(size)
            .ok_or("embedded request exceeds address space")?;
    }
    u32::try_from(length).map_err(|_| "embedded request exceeds u32 length")?;
    let mut bytes = Vec::with_capacity(length);
    bytes.extend_from_slice(b"WASM-EMB");
    append_field(&mut bytes, 1, 1, request.source.as_bytes());
    append_field(&mut bytes, 2, 1, request.filename.as_bytes());
    if let Some(width) = request.line_width {
        append_field(&mut bytes, 3, 0, &width.get().to_le_bytes());
    }
    Ok(bytes)
}

#[cfg(feature = "host-formatting")]
fn append_field(bytes: &mut Vec<u8>, tag: u16, flags: u16, value: &[u8]) {
    bytes.extend_from_slice(&tag.to_le_bytes());
    bytes.extend_from_slice(&flags.to_le_bytes());
    // encode_request validated the complete buffer length before allocating.
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value);
}

#[cfg(all(feature = "host-formatting", target_arch = "wasm32"))]
fn exchange(request: &[u8]) -> Result<Option<String>, String> {
    #[link(wasm_import_module = "wasm_fmt_host")]
    unsafe extern "C" {
        fn format_embedded(ptr: *const u8, len: u32) -> u32;
        fn embedded_result_len() -> u32;
        fn read_embedded_result(ptr: *mut u8, len: u32);
    }
    // Request storage remains live and immutable until the import returns.
    let status = unsafe { format_embedded(request.as_ptr(), request.len() as u32) };
    match status {
        0 => return Ok(None),
        1 | 3 => {}
        _ => panic!("host returned an invalid embedded format status"),
    }
    let len = unsafe { embedded_result_len() };
    let mut bytes = vec![0; len as usize];
    let ptr = if bytes.is_empty() {
        std::ptr::null_mut()
    } else {
        bytes.as_mut_ptr()
    };
    // This owned destination cannot alias the active source/configuration.
    unsafe { read_embedded_result(ptr, len) };
    let text = String::from_utf8(bytes).expect("host embedded result must be valid UTF-8");
    if status == 1 {
        Ok(Some(text))
    } else {
        Err(text)
    }
}

#[cfg(all(feature = "host-formatting", not(target_arch = "wasm32")))]
fn exchange(_request: &[u8]) -> Result<Option<String>, String> {
    Err("embedded host imports require a wasm32 guest".into())
}
