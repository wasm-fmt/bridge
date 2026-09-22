mod host;
pub use host::{EmbeddedRequest, Host};

use std::{
    collections::HashMap,
    fmt::Display,
    ops::Range,
    sync::{Mutex, MutexGuard, OnceLock},
};

pub use wasm_fmt_fdk_macros::{config, formatter};

pub const ABI_VERSION: u32 = 1;
pub const STATUS_NONE: u32 = 0;
pub const STATUS_OK: u32 = 1;
pub const STATUS_PARTIAL: u32 = 2;
pub const STATUS_ERROR: u32 = 3;

/// Formatter endpoint result with a string error by default.
///
/// A custom error type may be supplied as the second parameter when it
/// implements [`Display`].
pub type Result<T, E = String> = std::result::Result<T, E>;

const FIELD_FLAG_CRITICAL: u16 = 1;
const TAG_SOURCE: u16 = 1;
const TAG_FILENAME: u16 = 2;
const TAG_INLINE_CONFIG: u16 = 3;
const TAG_REGISTERED_CONFIG: u16 = 4;
const TAG_RANGES: u16 = 5;
const REQUEST_MAGIC: &[u8] = b"WASM-FMT";
const BYTE_STRING_PREFIX_LENGTH: u32 = 4;
const ERROR_BYTE_STRING_FALLBACK: &[u8] = b"\x0c\0\0\0bridge error";

/// Decodes formatter-owned configuration bytes into a native config value.
///
/// Bridge does not prescribe an encoding. Implementations may use JSON, TOML,
/// a custom binary format, or treat the bytes as their native representation.
/// Custom endpoint config types must also be annotated with [`config`]. The
/// attribute declares the guest's one concrete config type and supplies its
/// typed registered-config store; it does not implement this trait or choose
/// an encoding. Registered bytes are decoded eagerly by [`Config::decode`] and
/// cached as the concrete config type until their id is released.
pub trait Config: Sized + Send + 'static {
    fn decode(bytes: &[u8]) -> Result<Self, String>;
}

/// Internal config type used for formatter functions without a `config` parameter.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct NoConfig;

impl Config for NoConfig {
    fn decode(_bytes: &[u8]) -> Result<Self, String> {
        Err("formatter does not support configuration".to_string())
    }
}

impl Config for () {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() {
            return Ok(());
        }

        Err("unit config must be empty".to_string())
    }
}

impl Config for String {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|err| format!("config must be valid UTF-8: {err}"))
    }
}

impl Config for Vec<u8> {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        Ok(bytes.to_vec())
    }
}

macro_rules! impl_builtin_guest_config {
    ($type:ty) => {
        impl __private::GuestConfig for $type {
            fn store() -> &'static __private::ConfigStore<Self> {
                static STORE: OnceLock<__private::ConfigStore<$type>> = OnceLock::new();
                STORE.get_or_init(__private::ConfigStore::new)
            }
        }
    };
}

impl_builtin_guest_config!(());
impl_builtin_guest_config!(String);
impl_builtin_guest_config!(Vec<u8>);
impl_builtin_guest_config!(NoConfig);

/// Declares a formatter guest that does not support configuration.
///
/// Configured guests use [`config`] on their one concrete configuration type
/// instead. Either declaration supplies the configuration lifecycle exports;
/// declaring both, or declaring either more than once, is a link-time error.
#[macro_export]
macro_rules! guest {
    () => {
        #[doc(hidden)]
        #[unsafe(export_name = "wasm_fmt_register_config")]
        pub extern "C" fn __bridge_register_no_config(id: u32, ptr: u32, len: u32) -> u32 {
            ::bridge::__private::register_no_config(id, ptr, len)
        }

        #[doc(hidden)]
        #[unsafe(export_name = "wasm_fmt_release_config")]
        pub extern "C" fn __bridge_release_no_config(id: u32) {
            ::bridge::__private::release_no_config(id)
        }
    };
    (config = $config:ty) => {
        #[doc(hidden)]
        #[unsafe(export_name = "wasm_fmt_register_config")]
        pub extern "C" fn __bridge_register_builtin_config(id: u32, ptr: u32, len: u32) -> u32 {
            ::bridge::__private::register_config::<$config>(id, ptr, len)
        }

        #[doc(hidden)]
        #[unsafe(export_name = "wasm_fmt_release_config")]
        pub extern "C" fn __bridge_release_builtin_config(id: u32) {
            ::bridge::__private::release_config::<$config>(id)
        }
    };
}

/// A UTF-8 text replacement against byte offsets in the original source.
///
/// Partial updates must be ordered, non-overlapping, in bounds, and aligned to
/// UTF-8 character boundaries.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextEdit {
    pub range: Range<u32>,
    pub text: String,
}

/// The formatter's explicit result.
///
/// Bridge trusts the selected variant. In particular, a [`FullUpdate`](Self::FullUpdate)
/// remains a full update even when its text equals the source, and an empty
/// [`PartialUpdate`](Self::PartialUpdate) remains a partial update.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FormatResult {
    Unchanged,
    FullUpdate(String),
    PartialUpdate(Vec<TextEdit>),
    Error(String),
}

/// Converts a formatter function's return value into an explicit result.
pub trait IntoFormatResult {
    fn into_format_result(self) -> FormatResult;
}

impl IntoFormatResult for String {
    fn into_format_result(self) -> FormatResult {
        FormatResult::FullUpdate(self)
    }
}

impl IntoFormatResult for FormatResult {
    fn into_format_result(self) -> FormatResult {
        self
    }
}

impl<T, E> IntoFormatResult for Result<T, E>
where
    T: IntoFormatResult,
    E: Display,
{
    fn into_format_result(self) -> FormatResult {
        match self {
            Ok(value) => value.into_format_result(),
            Err(error) => FormatResult::Error(error.to_string()),
        }
    }
}

/// Describes how a generated endpoint accepts the `ranges` request field.
///
/// This is public only for code generated by [`formatter`].
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RangesMode {
    Unsupported,
    Optional,
    Required,
}

/// Describes how a generated endpoint accepts configuration.
///
/// This is public only for code generated by [`formatter`].
#[doc(hidden)]
#[derive(Clone, Copy)]
pub enum ConfigMode<C> {
    Unsupported,
    Default(fn() -> C),
    Optional,
}

impl RangesMode {
    fn validate(self, ranges: Option<&[Range<u32>]>) -> Result<(), &'static str> {
        match (self, ranges) {
            (Self::Unsupported, Some(_)) => Err("formatter endpoint does not support ranges"),
            (Self::Required, None) => Err("formatter endpoint requires ranges"),
            _ => Ok(()),
        }
    }
}

struct State {
    input: Option<Vec<u8>>,
    output: Vec<u8>,
    error: ErrorByteString,
}

impl Default for State {
    fn default() -> Self {
        Self {
            input: None,
            output: Vec::new(),
            error: ErrorByteString::Empty,
        }
    }
}

impl State {
    fn alloc(&mut self, size: u32) -> u32 {
        let mut input = vec![0; size as usize];
        let ptr = if input.is_empty() {
            0
        } else {
            input.as_mut_ptr() as u32
        };
        self.input = Some(input);
        ptr
    }

    fn reset(&mut self) {
        self.input = None;
        self.output.clear();
        self.error.clear();
    }

    fn register_config<C: __private::GuestConfig>(&mut self, id: u32, ptr: u32, len: u32) -> u32 {
        let input = self.take_input(ptr, len);
        self.register_config_bytes::<C>(id, &input)
    }

    fn register_config_bytes<C: __private::GuestConfig>(&mut self, id: u32, bytes: &[u8]) -> u32 {
        self.clear_result();

        if id == 0 {
            self.set_error("config id 0 is reserved");
            return STATUS_ERROR;
        }

        match C::store().register(id, bytes) {
            Ok(()) => STATUS_OK,
            Err(error) => {
                self.set_error(&error);
                STATUS_ERROR
            }
        }
    }

    fn take_input(&mut self, ptr: u32, len: u32) -> Vec<u8> {
        let input = self
            .input
            .take()
            .expect("input transaction requires an allocation");
        let expected_ptr = if input.is_empty() {
            0
        } else {
            input.as_ptr() as u32
        };
        assert_eq!(
            ptr, expected_ptr,
            "request must use the current input allocation"
        );
        assert_eq!(
            len as usize,
            input.len(),
            "request must use the complete input allocation"
        );
        input
    }

    fn invoke<C, F>(
        &mut self,
        ptr: u32,
        len: u32,
        config_mode: ConfigMode<C>,
        ranges_mode: RangesMode,
        endpoint: F,
    ) -> u32
    where
        C: __private::GuestConfig,
        F: FnOnce(&str, Option<&str>, Option<&C>, Option<&[Range<u32>]>) -> FormatResult,
    {
        let input = self.take_input(ptr, len);
        self.invoke_request::<C, F>(&input, config_mode, ranges_mode, endpoint)
    }

    fn invoke_request<C, F>(
        &mut self,
        request: &[u8],
        config_mode: ConfigMode<C>,
        ranges_mode: RangesMode,
        endpoint: F,
    ) -> u32
    where
        C: __private::GuestConfig,
        F: FnOnce(&str, Option<&str>, Option<&C>, Option<&[Range<u32>]>) -> FormatResult,
    {
        self.clear_result();

        let request = match parse_request(request) {
            Ok(request) => request,
            Err(err) => {
                self.set_error(&err);
                return STATUS_ERROR;
            }
        };

        let source = match std::str::from_utf8(request.source) {
            Ok(source) => source,
            Err(err) => {
                self.set_error(&err.to_string());
                return STATUS_ERROR;
            }
        };

        let filename = match request.filename {
            Some(filename) => match std::str::from_utf8(filename) {
                Ok(filename) => Some(filename),
                Err(err) => {
                    self.set_error(&err.to_string());
                    return STATUS_ERROR;
                }
            },
            None => None,
        };

        let ranges = match decode_ranges(source, request.ranges) {
            Ok(ranges) => ranges,
            Err(err) => {
                self.set_error(&err);
                return STATUS_ERROR;
            }
        };
        if let Err(err) = ranges_mode.validate(ranges.as_deref()) {
            self.set_error(err);
            return STATUS_ERROR;
        }

        let result = match Self::with_config::<C, _>(
            config_mode,
            request.inline_config,
            request.registered_config,
            |config| endpoint(source, filename, config, ranges.as_deref()),
        ) {
            Ok(result) => result,
            Err(err) => {
                self.set_error(&err);
                return STATUS_ERROR;
            }
        };

        self.apply_format_result(source, result)
    }

    fn output(&self) -> u32 {
        byte_string_ptr(&self.output)
    }

    fn error(&self) -> u32 {
        byte_string_ptr(self.error.as_slice())
    }

    fn with_config<C: __private::GuestConfig, T>(
        config_mode: ConfigMode<C>,
        inline_config: Option<&[u8]>,
        registered_config: Option<u32>,
        use_config: impl FnOnce(Option<&C>) -> T,
    ) -> Result<T, String> {
        if (inline_config.is_some() || registered_config.is_some())
            && matches!(config_mode, ConfigMode::Unsupported)
        {
            return Err("formatter does not support configuration".to_string());
        }

        if let Some(bytes) = inline_config {
            let config = C::decode(bytes)?;
            return Ok(use_config(Some(&config)));
        }
        if let Some(id) = registered_config {
            if id == 0 {
                return Err("registered_config id 0 is reserved".to_string());
            }

            return C::store().with_config(id, |config| use_config(Some(config)));
        }

        match config_mode {
            ConfigMode::Unsupported | ConfigMode::Optional => Ok(use_config(None)),
            ConfigMode::Default(default_config) => {
                let config = default_config();
                Ok(use_config(Some(&config)))
            }
        }
    }

    fn clear_result(&mut self) {
        self.output.clear();
        self.error.clear();
    }

    fn set_output_status(&mut self, payload: &[u8], success_status: u32) -> u32 {
        let encoded = make_byte_string(payload);
        self.store_output_result(encoded, success_status)
    }

    fn store_output_result(
        &mut self,
        encoded: Result<Vec<u8>, ByteStringError>,
        success_status: u32,
    ) -> u32 {
        match encoded {
            Ok(output) => {
                self.output = output;
                self.error.clear();
                success_status
            }
            Err(error) => {
                self.set_error(error.message());
                STATUS_ERROR
            }
        }
    }

    fn set_error(&mut self, message: &str) {
        self.output.clear();
        self.error = ErrorByteString::from_encoded(make_byte_string(message.as_bytes()));
    }

    fn apply_format_result(&mut self, source: &str, result: FormatResult) -> u32 {
        match result {
            FormatResult::Unchanged => STATUS_NONE,
            FormatResult::FullUpdate(formatted) => {
                self.set_output_status(formatted.as_bytes(), STATUS_OK)
            }
            FormatResult::PartialUpdate(edits) => match encode_partial_update(source, &edits) {
                Ok(payload) => self.set_output_status(&payload, STATUS_PARTIAL),
                Err(error) => {
                    self.set_error(&error);
                    STATUS_ERROR
                }
            },
            FormatResult::Error(error) => {
                self.set_error(&error);
                STATUS_ERROR
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ByteStringError {
    PayloadTooLarge,
    AllocationFailed,
}

impl ByteStringError {
    fn message(self) -> &'static str {
        match self {
            Self::PayloadTooLarge => "ByteString payload is too large",
            Self::AllocationFailed => "failed to allocate ByteString",
        }
    }
}

enum ErrorByteString {
    Empty,
    Owned(Vec<u8>),
    Fallback,
}

impl ErrorByteString {
    fn from_encoded(encoded: Result<Vec<u8>, ByteStringError>) -> Self {
        match encoded {
            Ok(bytes) => Self::Owned(bytes),
            Err(_) => Self::Fallback,
        }
    }

    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Empty => &[],
            Self::Owned(bytes) => bytes,
            Self::Fallback => ERROR_BYTE_STRING_FALLBACK,
        }
    }

    fn clear(&mut self) {
        *self = Self::Empty;
    }
}

#[derive(Debug)]
struct FormatRequest<'a> {
    source: &'a [u8],
    filename: Option<&'a [u8]>,
    inline_config: Option<&'a [u8]>,
    registered_config: Option<u32>,
    ranges: Option<&'a [u8]>,
}

fn parse_request(request: &[u8]) -> Result<FormatRequest<'_>, String> {
    if request.len() < REQUEST_MAGIC.len() || &request[..REQUEST_MAGIC.len()] != REQUEST_MAGIC {
        return Err("request magic must be WASM-FMT".to_string());
    }

    let mut offset = REQUEST_MAGIC.len();
    let mut source = None;
    let mut filename = None;
    let mut inline_config = None;
    let mut registered_config = None;
    let mut ranges = None;

    while offset < request.len() {
        if request.len() - offset < 8 {
            return Err("truncated TLV field header".to_string());
        }

        let tag = u16::from_le_bytes([request[offset], request[offset + 1]]);
        let field_flags = u16::from_le_bytes([request[offset + 2], request[offset + 3]]);
        let field_len = u32::from_le_bytes([
            request[offset + 4],
            request[offset + 5],
            request[offset + 6],
            request[offset + 7],
        ]) as usize;
        offset += 8;

        if field_flags & !FIELD_FLAG_CRITICAL != 0 {
            return Err(format!("field {tag} has unsupported flags"));
        }
        if request.len() - offset < field_len {
            return Err(format!("field {tag} extends past request length"));
        }

        let value = &request[offset..offset + field_len];
        offset += field_len;

        match tag {
            TAG_SOURCE => set_once(&mut source, value, "duplicate source field")?,
            TAG_FILENAME => set_once(&mut filename, value, "duplicate filename field")?,
            TAG_INLINE_CONFIG => {
                set_once(&mut inline_config, value, "duplicate inline_config field")?;
            }
            TAG_REGISTERED_CONFIG => {
                if registered_config.is_some() {
                    return Err("duplicate registered_config field".to_string());
                }
                if value.len() != 4 {
                    return Err("registered_config field must be a u32".to_string());
                }
                registered_config =
                    Some(u32::from_le_bytes([value[0], value[1], value[2], value[3]]));
            }
            TAG_RANGES => {
                if field_flags != 0 {
                    return Err("ranges field flags must be 0".to_string());
                }
                set_once(&mut ranges, value, "duplicate ranges field")?;
            }
            _ if field_flags & FIELD_FLAG_CRITICAL != 0 => {
                return Err(format!("unknown critical field {tag}"));
            }
            _ => {}
        }
    }

    let source = source.ok_or_else(|| "missing source field".to_string())?;
    if inline_config.is_some() && registered_config.is_some() {
        return Err("inline_config and registered_config are mutually exclusive".to_string());
    }

    Ok(FormatRequest {
        source,
        filename,
        inline_config,
        registered_config,
        ranges,
    })
}

fn decode_ranges(source: &str, payload: Option<&[u8]>) -> Result<Option<Vec<Range<u32>>>, String> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    if payload.len() < 4 {
        return Err("ranges field is missing its count".to_string());
    }

    let count = u32::from_le_bytes(payload[..4].try_into().expect("range count is four bytes"));
    let count =
        usize::try_from(count).map_err(|_| "range count cannot be represented by this guest")?;
    let records_length = count
        .checked_mul(8)
        .ok_or_else(|| "ranges field length overflow".to_string())?;
    let expected_length = records_length
        .checked_add(4)
        .ok_or_else(|| "ranges field length overflow".to_string())?;
    if payload.len() != expected_length {
        return Err(format!(
            "ranges field length must be {expected_length} bytes for {count} ranges"
        ));
    }

    let mut ranges = Vec::new();
    ranges
        .try_reserve_exact(count)
        .map_err(|_| "failed to allocate ranges".to_string())?;

    let mut offset = 4;
    for index in 0..count {
        let start = u32::from_le_bytes(
            payload[offset..offset + 4]
                .try_into()
                .expect("range start is four bytes"),
        );
        let end = u32::from_le_bytes(
            payload[offset + 4..offset + 8]
                .try_into()
                .expect("range end is four bytes"),
        );
        offset += 8;

        validate_range(source, index, start, end)?;
        ranges.push(start..end);
    }

    Ok(Some(ranges))
}

fn validate_range(source: &str, index: usize, start: u32, end: u32) -> Result<(), String> {
    if start > end {
        return Err(format!("range {index} is inverted: {start}..{end}"));
    }

    let start_index = usize::try_from(start)
        .map_err(|_| format!("range {index} start {start} cannot be represented by this guest"))?;
    let end_index = usize::try_from(end)
        .map_err(|_| format!("range {index} end {end} cannot be represented by this guest"))?;
    if end_index > source.len() {
        return Err(format!(
            "range {index} {start}..{end} exceeds source length {}",
            source.len()
        ));
    }
    if !source.is_char_boundary(start_index) {
        return Err(format!(
            "range {index} start {start} is not a UTF-8 boundary"
        ));
    }
    if !source.is_char_boundary(end_index) {
        return Err(format!("range {index} end {end} is not a UTF-8 boundary"));
    }

    Ok(())
}

fn set_once<'a>(
    slot: &mut Option<&'a [u8]>,
    value: &'a [u8],
    duplicate_message: &str,
) -> Result<(), String> {
    if slot.is_some() {
        return Err(duplicate_message.to_string());
    }
    *slot = Some(value);
    Ok(())
}

fn byte_string_layout(payload_length: usize) -> Result<(u32, usize), ByteStringError> {
    let encoded_length =
        u32::try_from(payload_length).map_err(|_| ByteStringError::PayloadTooLarge)?;
    let total_length = encoded_length
        .checked_add(BYTE_STRING_PREFIX_LENGTH)
        .ok_or(ByteStringError::PayloadTooLarge)?;
    let allocation_length =
        usize::try_from(total_length).map_err(|_| ByteStringError::PayloadTooLarge)?;

    Ok((encoded_length, allocation_length))
}

fn make_byte_string(payload: &[u8]) -> Result<Vec<u8>, ByteStringError> {
    let (encoded_length, allocation_length) = byte_string_layout(payload.len())?;
    let mut buf = Vec::new();
    buf.try_reserve_exact(allocation_length)
        .map_err(|_| ByteStringError::AllocationFailed)?;
    buf.extend_from_slice(&encoded_length.to_le_bytes());
    buf.extend_from_slice(payload);
    Ok(buf)
}

fn encode_partial_update(source: &str, edits: &[TextEdit]) -> Result<Vec<u8>, String> {
    validate_partial_update(source, edits)?;

    let edit_count = u32::try_from(edits.len())
        .map_err(|_| "partial update contains too many edits".to_string())?;
    let mut payload_capacity = 4_usize;

    for edit in edits {
        u32::try_from(edit.text.len()).map_err(|_| "partial edit text is too large".to_string())?;
        payload_capacity = payload_capacity
            .checked_add(12)
            .and_then(|capacity| capacity.checked_add(edit.text.len()))
            .ok_or_else(|| "partial update payload is too large".to_string())?;
    }

    byte_string_layout(payload_capacity)
        .map_err(|_| "partial update payload is too large".to_string())?;
    let mut payload = Vec::new();
    payload
        .try_reserve_exact(payload_capacity)
        .map_err(|_| "failed to allocate partial update payload".to_string())?;
    payload.extend_from_slice(&edit_count.to_le_bytes());

    for edit in edits {
        let text_length = u32::try_from(edit.text.len())
            .map_err(|_| "partial edit text is too large".to_string())?;
        payload.extend_from_slice(&edit.range.start.to_le_bytes());
        payload.extend_from_slice(&edit.range.end.to_le_bytes());
        payload.extend_from_slice(&text_length.to_le_bytes());
        payload.extend_from_slice(edit.text.as_bytes());
    }

    Ok(payload)
}

fn validate_partial_update(source: &str, edits: &[TextEdit]) -> Result<(), String> {
    let mut previous_range: Option<Range<u32>> = None;

    for (index, edit) in edits.iter().enumerate() {
        let start = edit.range.start;
        let end = edit.range.end;

        if start > end {
            return Err(format!(
                "partial edit {index} has an inverted range {start}..{end}"
            ));
        }
        let start_index = usize::try_from(start).map_err(|_| {
            format!("partial edit {index} start {start} cannot be represented by this guest")
        })?;
        let end_index = usize::try_from(end).map_err(|_| {
            format!("partial edit {index} end {end} cannot be represented by this guest")
        })?;
        if end_index > source.len() {
            return Err(format!(
                "partial edit {index} range {start}..{end} exceeds source length {}",
                source.len()
            ));
        }
        if !source.is_char_boundary(start_index) {
            return Err(format!(
                "partial edit {index} start {start} is not a UTF-8 boundary"
            ));
        }
        if !source.is_char_boundary(end_index) {
            return Err(format!(
                "partial edit {index} end {end} is not a UTF-8 boundary"
            ));
        }

        if let Some(previous_range) = previous_range {
            if start < previous_range.start {
                return Err(format!("partial edit {index} is out of order"));
            }
            if start < previous_range.end {
                return Err(format!("partial edit {index} overlaps the previous edit"));
            }
        }

        previous_range = Some(edit.range.clone());
    }

    Ok(())
}

fn byte_string_ptr(buf: &[u8]) -> u32 {
    if buf.is_empty() {
        return 0;
    }
    buf.as_ptr() as u32
}

static BRIDGE_STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn bridge_state() -> MutexGuard<'static, State> {
    BRIDGE_STATE
        .get_or_init(|| Mutex::new(State::default()))
        .try_lock()
        .expect("Bridge calls must be serial, non-reentrant, and stop after a trap")
}

/// Invokes a generated formatter endpoint against the shared Bridge state.
///
/// This module is public only for code generated by [`formatter`].
#[doc(hidden)]
pub mod __private {
    use super::{
        Config, ConfigMode, FormatResult, HashMap, Mutex, NoConfig, Range, RangesMode,
        STATUS_ERROR, bridge_state,
    };

    /// A config-type-specific registry generated once for the guest's declared
    /// configuration type.
    pub struct ConfigStore<C> {
        values: Mutex<HashMap<u32, C>>,
    }

    impl<C> Default for ConfigStore<C> {
        fn default() -> Self {
            Self {
                values: Mutex::new(HashMap::new()),
            }
        }
    }

    impl<C> ConfigStore<C> {
        pub fn new() -> Self {
            Self::default()
        }
    }

    impl<C: Config> ConfigStore<C> {
        pub fn register(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
            let mut values = self
                .values
                .try_lock()
                .expect("configuration access must not be reentrant");
            let std::collections::hash_map::Entry::Vacant(entry) = values.entry(id) else {
                return Err(format!("registered_config id {id} is already live"));
            };
            let config = C::decode(bytes)?;
            entry.insert(config);
            Ok(())
        }

        pub fn with_config<T>(
            &self,
            id: u32,
            use_config: impl FnOnce(&C) -> T,
        ) -> Result<T, String> {
            let values = self
                .values
                .try_lock()
                .expect("configuration access must not be reentrant");
            let config = values
                .get(&id)
                .ok_or_else(|| format!("registered_config id {id} was not found"))?;
            Ok(use_config(config))
        }

        pub fn remove(&self, id: u32) {
            self.values
                .try_lock()
                .expect("configuration access must not be reentrant")
                .remove(&id);
        }
    }

    /// Identifies the one concrete configuration type declared by the guest.
    ///
    /// Implementations are generated by [`crate::config`]. The associated
    /// store is statically typed, so resolving a registered configuration never
    /// performs `Any`, `TypeId`, or downcasting.
    pub trait GuestConfig: Config {
        fn store() -> &'static ConfigStore<Self>;
    }

    pub fn register_config<C: GuestConfig>(id: u32, ptr: u32, len: u32) -> u32 {
        bridge_state().register_config::<C>(id, ptr, len)
    }

    pub fn release_config<C: GuestConfig>(id: u32) {
        C::store().remove(id);
    }

    pub fn register_no_config(_id: u32, _ptr: u32, _len: u32) -> u32 {
        let mut state = bridge_state();
        state.clear_result();
        state.set_error("formatter does not support configuration");
        STATUS_ERROR
    }

    pub fn release_no_config(_id: u32) {}

    pub fn invoke_with_default<C, F>(
        ptr: u32,
        len: u32,
        ranges_mode: RangesMode,
        endpoint: F,
    ) -> u32
    where
        C: GuestConfig + Default,
        F: FnOnce(&str, Option<&str>, Option<&C>, Option<&[Range<u32>]>) -> FormatResult,
    {
        bridge_state().invoke::<C, F>(
            ptr,
            len,
            ConfigMode::Default(C::default),
            ranges_mode,
            endpoint,
        )
    }

    pub fn invoke_optional<C, F>(ptr: u32, len: u32, ranges_mode: RangesMode, endpoint: F) -> u32
    where
        C: GuestConfig,
        F: FnOnce(&str, Option<&str>, Option<&C>, Option<&[Range<u32>]>) -> FormatResult,
    {
        bridge_state().invoke::<C, F>(ptr, len, ConfigMode::Optional, ranges_mode, endpoint)
    }

    pub fn invoke_no_config<F>(ptr: u32, len: u32, ranges_mode: RangesMode, endpoint: F) -> u32
    where
        F: FnOnce(&str, Option<&str>, Option<&NoConfig>, Option<&[Range<u32>]>) -> FormatResult,
    {
        bridge_state().invoke::<NoConfig, F>(
            ptr,
            len,
            ConfigMode::Unsupported,
            ranges_mode,
            endpoint,
        )
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_fmt_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_fmt_alloc(size: u32) -> u32 {
    bridge_state().alloc(size)
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_fmt_reset() {
    bridge_state().reset()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_fmt_output() -> u32 {
    bridge_state().output()
}

#[unsafe(no_mangle)]
pub extern "C" fn wasm_fmt_error() -> u32 {
    bridge_state().error()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    fn request(fields: &[(u16, u16, &[u8])]) -> Vec<u8> {
        let mut request = REQUEST_MAGIC.to_vec();

        for (tag, flags, value) in fields {
            request.extend_from_slice(&tag.to_le_bytes());
            request.extend_from_slice(&flags.to_le_bytes());
            request.extend_from_slice(&(value.len() as u32).to_le_bytes());
            request.extend_from_slice(value);
        }

        request
    }

    fn edit(range: Range<u32>, text: &str) -> TextEdit {
        TextEdit {
            range,
            text: text.to_string(),
        }
    }

    fn byte_string_payload(bytes: &[u8]) -> &[u8] {
        let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;

        assert_eq!(bytes.len(), length + 4);
        &bytes[4..]
    }

    #[test]
    fn request_extensions_preserve_the_abi_contract() {
        let request_bytes = request(&[(TAG_SOURCE, 0, b"select 1"), (99, 0, b"ignored")]);
        parse_request(&request_bytes).unwrap();

        let request_bytes = request(&[
            (TAG_SOURCE, 0, b"select 1"),
            (99, FIELD_FLAG_CRITICAL, b"required"),
        ]);
        assert!(parse_request(&request_bytes).is_err());

        let id = 1_u32.to_le_bytes();
        let request_bytes = request(&[
            (TAG_SOURCE, 0, b"select 1"),
            (TAG_INLINE_CONFIG, 0, &[2]),
            (TAG_REGISTERED_CONFIG, 0, &id),
        ]);
        assert!(parse_request(&request_bytes).is_err());
    }

    #[test]
    fn byte_string_layout_reserves_prefix_within_the_u32_limit() {
        let maximum_total_length = usize::try_from(u32::MAX).unwrap();
        let maximum_payload_length =
            maximum_total_length - usize::try_from(BYTE_STRING_PREFIX_LENGTH).unwrap();

        assert_eq!(
            byte_string_layout(maximum_payload_length),
            Ok((u32::MAX - BYTE_STRING_PREFIX_LENGTH, maximum_total_length))
        );
        assert_eq!(
            byte_string_layout(maximum_payload_length + 1),
            Err(ByteStringError::PayloadTooLarge)
        );

        if usize::BITS > u32::BITS {
            assert_eq!(
                byte_string_layout(maximum_total_length + 1),
                Err(ByteStringError::PayloadTooLarge)
            );
        }
    }

    #[test]
    fn error_byte_string_has_a_static_valid_fallback() {
        let error = ErrorByteString::from_encoded(Err(ByteStringError::AllocationFailed));

        assert_eq!(byte_string_payload(error.as_slice()), b"bridge error");
    }

    #[test]
    fn output_encoding_failures_map_full_and_partial_updates_to_error() {
        for success_status in [STATUS_OK, STATUS_PARTIAL] {
            let mut state = State::default();

            let status =
                state.store_output_result(Err(ByteStringError::PayloadTooLarge), success_status);

            assert_eq!(status, STATUS_ERROR);
            assert!(state.output.is_empty());
            assert_eq!(
                byte_string_payload(state.error.as_slice()),
                b"ByteString payload is too large"
            );
        }
    }

    #[test]
    fn into_format_result_supports_common_formatter_returns() {
        #[derive(Debug)]
        struct CustomError;

        impl fmt::Display for CustomError {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("custom error")
            }
        }

        assert_eq!(
            "formatted".to_string().into_format_result(),
            FormatResult::FullUpdate("formatted".to_string())
        );

        let partial = FormatResult::PartialUpdate(vec![edit(0..1, "F")]);
        assert_eq!(partial.clone().into_format_result(), partial);

        let success: Result<String, CustomError> = Ok("formatted".to_string());
        assert_eq!(
            success.into_format_result(),
            FormatResult::FullUpdate("formatted".to_string())
        );

        let failure: Result<String, CustomError> = Err(CustomError);
        assert_eq!(
            failure.into_format_result(),
            FormatResult::Error("custom error".to_string())
        );
    }

    #[test]
    fn partial_update_uses_counted_little_endian_records() {
        let encoded = encode_partial_update("aé", &[edit(0..1, "X"), edit(1..3, "🙂")]).unwrap();

        assert_eq!(
            encoded,
            vec![
                2, 0, 0, 0, // edit count
                0, 0, 0, 0, // first range start
                1, 0, 0, 0, // first range end
                1, 0, 0, 0,    // first text byte length
                b'X', //
                1, 0, 0, 0, // second range start
                3, 0, 0, 0, // second range end
                4, 0, 0, 0, // second text byte length
                0xf0, 0x9f, 0x99, 0x82, // "🙂"
            ]
        );
    }

    #[test]
    fn partial_update_enforces_structural_safety() {
        let edits = [edit(0..1, "a"), edit(1..1, "insert"), edit(1..4, "rest")];
        validate_partial_update("text", &edits).unwrap();

        let inverted_range = Range { start: 2, end: 1 };
        let cases = [
            ("abc", vec![edit(inverted_range, "")]),
            ("abc", vec![edit(0..4, "")]),
            ("é", vec![edit(1..2, "")]),
            ("é", vec![edit(0..1, "")]),
            ("abc", vec![edit(2..2, ""), edit(1..1, "")]),
            ("abc", vec![edit(0..2, ""), edit(1..3, "")]),
        ];

        for (source, edits) in cases {
            assert!(validate_partial_update(source, &edits).is_err());
        }
    }

    #[test]
    fn common_config_types_preserve_their_public_contract() {
        assert_eq!(Vec::<u8>::decode(&[0xff, 0x00]).unwrap(), [0xff, 0x00]);
        assert_eq!(String::decode(b"plain text").unwrap(), "plain text");
        assert!(String::decode(&[0xff]).is_err());
        assert!(<()>::decode(b"unexpected").is_err());
    }

    #[test]
    fn registration_is_typed_and_no_config_endpoints_reject_configuration() {
        let mut state = State::default();

        assert_eq!(
            state.register_config_bytes::<NoConfig>(1, b""),
            STATUS_ERROR
        );

        let request = request(&[(TAG_SOURCE, 0, b"source"), (TAG_INLINE_CONFIG, 0, b"")]);
        let parsed = parse_request(&request).unwrap();
        let error = State::with_config::<NoConfig, _>(
            ConfigMode::Unsupported,
            parsed.inline_config,
            parsed.registered_config,
            |_| (),
        )
        .unwrap_err();

        assert_eq!(error, "formatter does not support configuration");
    }
}
