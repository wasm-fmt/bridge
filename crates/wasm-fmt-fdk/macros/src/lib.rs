use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{
    Error, FnArg, GenericArgument, Item, ItemFn, Pat, PathArguments, Result, Type, ext::IdentExt,
    parse_macro_input,
};

/// Declares a custom struct or enum as the guest's one formatter configuration type.
///
/// This attribute never implements `bridge::Config` or chooses an encoding.
/// The annotated type must provide that implementation explicitly. It also
/// emits the typed registered-config store and config lifecycle exports for
/// the guest, so it may appear only once in a final Wasm guest.
#[proc_macro_attribute]
pub fn config(args: TokenStream, input: TokenStream) -> TokenStream {
    let args = TokenStream2::from(args);
    if let Err(error) = validate_config_attribute_arguments(&args) {
        return error.into_compile_error().into();
    }

    let item = parse_macro_input!(input as Item);

    expand_config(item)
        .unwrap_or_else(Error::into_compile_error)
        .into()
}

/// Exports a typed formatter endpoint as `wasm_fmt_<function_name>`.
///
/// Parameters may appear in any order. Their conventional names determine
/// their Bridge request fields:
///
/// - `host: &bridge::Host<'_>` for synchronous embedded formatting
/// - `source: &str`
/// - `filename: Option<&str>`
/// - `config: &T` where an absent field supplies `T::default()`
/// - `config: Option<&T>` to preserve absent versus present config
/// - `ranges: &[Range<u32>]` for a required ranges field
/// - `ranges: Option<&[Range<u32>]>` for an optional ranges field
///
/// The return value must implement `bridge::IntoFormatResult`.
///
/// Multiple annotated functions may coexist and share the FDK's core ABI state.
#[proc_macro_attribute]
pub fn formatter(args: TokenStream, input: TokenStream) -> TokenStream {
    let args = TokenStream2::from(args);
    if let Err(error) = validate_attribute_arguments(&args) {
        return error.into_compile_error().into();
    }

    let function = parse_macro_input!(input as ItemFn);

    expand_formatter(function)
        .unwrap_or_else(Error::into_compile_error)
        .into()
}

fn expand_config(item: Item) -> Result<TokenStream2> {
    let (name, generics) = match &item {
        Item::Struct(item) => (&item.ident, &item.generics),
        Item::Enum(item) => (&item.ident, &item.generics),
        _ => {
            return Err(Error::new_spanned(
                item,
                "`#[bridge::config]` may only annotate a struct or enum",
            ));
        }
    };
    if !generics.params.is_empty() || generics.where_clause.is_some() {
        return Err(Error::new_spanned(
            generics,
            "`#[bridge::config]` requires a concrete, non-generic guest config type",
        ));
    }

    let register_export = format_ident!("__bridge_register_config_for_{}", name.unraw());
    let release_export = format_ident!("__bridge_release_config_for_{}", name.unraw());

    Ok(quote! {
        #item

        impl ::bridge::__private::GuestConfig for #name
        where
            #name: ::bridge::Config,
        {
            fn store() -> &'static ::bridge::__private::ConfigStore<Self> {
                static STORE: ::std::sync::OnceLock<
                    ::bridge::__private::ConfigStore<#name>
                > = ::std::sync::OnceLock::new();
                STORE.get_or_init(::bridge::__private::ConfigStore::new)
            }
        }

        #[doc(hidden)]
        #[allow(non_snake_case)]
        #[unsafe(export_name = "wasm_fmt_register_config")]
        pub extern "C" fn #register_export(id: u32, ptr: u32, len: u32) -> u32 {
            ::bridge::__private::register_config::<#name>(id, ptr, len)
        }

        #[doc(hidden)]
        #[allow(non_snake_case)]
        #[unsafe(export_name = "wasm_fmt_release_config")]
        pub extern "C" fn #release_export(id: u32) {
            ::bridge::__private::release_config::<#name>(id)
        }
    })
}

fn validate_config_attribute_arguments(args: &TokenStream2) -> Result<()> {
    if args.is_empty() {
        return Ok(());
    }

    Err(Error::new_spanned(
        args,
        "`#[bridge::config]` does not accept arguments",
    ))
}

fn expand_formatter(function: ItemFn) -> Result<TokenStream2> {
    validate_function(&function)?;

    let signature = FormatterSignature::from_function(&function)?;
    let function_name = &function.sig.ident;
    let endpoint_name = function_name.unraw().to_string();
    let export_name = format!("wasm_fmt_{endpoint_name}");
    let endpoint_function = format_ident!("__bridge_endpoint_{}", endpoint_name);
    let endpoint_export = format_ident!("__bridge_export_{}", endpoint_name);
    let config_mode = signature.config_mode;
    let config_type = signature
        .config_type
        .map(|config_type| quote!(#config_type))
        .unwrap_or_else(|| quote!(::bridge::NoConfig));
    let call_arguments = signature
        .parameters
        .iter()
        .map(FormatterParameter::expression);
    let ranges_mode = signature.ranges_mode.expression();
    let host = signature
        .parameters
        .contains(&FormatterParameter::Host)
        .then(|| {
            quote! {
                // This wrapper runs only after FDK request/config decoding.
                let _bridge_host = unsafe { ::bridge::Host::__for_call(_bridge_source) };
            }
        });
    let endpoint_invocation = match config_mode {
        ConfigMode::Default => quote! {
            ::bridge::__private::invoke_with_default::<#config_type, _>(
                ptr,
                len,
                #ranges_mode,
                #endpoint_function,
            )
        },
        ConfigMode::Optional => quote! {
            ::bridge::__private::invoke_optional::<#config_type, _>(
                ptr,
                len,
                #ranges_mode,
                #endpoint_function,
            )
        },
        ConfigMode::Unsupported => quote! {
            ::bridge::__private::invoke_no_config(
                ptr,
                len,
                #ranges_mode,
                #endpoint_function,
            )
        },
    };

    Ok(quote! {
        #function

        #[doc(hidden)]
        fn #endpoint_function(
            _bridge_source: &str,
            _bridge_filename: Option<&str>,
            _bridge_config: Option<&#config_type>,
            _bridge_ranges: Option<&[::std::ops::Range<u32>]>,
        ) -> ::bridge::FormatResult {
            #host
            ::bridge::IntoFormatResult::into_format_result(
                #function_name(#(#call_arguments),*)
            )
        }

        #[doc(hidden)]
        #[unsafe(export_name = #export_name)]
        pub extern "C" fn #endpoint_export(ptr: u32, len: u32) -> u32 {
            #endpoint_invocation
        }
    })
}

fn validate_attribute_arguments(args: &TokenStream2) -> Result<()> {
    if args.is_empty() {
        return Ok(());
    }

    Err(Error::new_spanned(
        args,
        "`#[bridge::formatter]` does not accept arguments; declare a parameter named `config` instead",
    ))
}

fn validate_function(function: &ItemFn) -> Result<()> {
    let signature = &function.sig;
    let endpoint_name = signature.ident.unraw().to_string();

    if !endpoint_name.is_ascii() {
        return Err(Error::new_spanned(
            &signature.ident,
            "formatter endpoint names must be ASCII",
        ));
    }
    if matches!(
        endpoint_name.as_str(),
        "abi_version"
            | "alloc"
            | "reset"
            | "register_config"
            | "release_config"
            | "output"
            | "error"
    ) {
        return Err(Error::new_spanned(
            &signature.ident,
            format!("`{endpoint_name}` is reserved by the Bridge core ABI"),
        ));
    }

    if signature.constness.is_some() {
        return Err(Error::new_spanned(
            signature,
            "formatter functions cannot be const",
        ));
    }
    if signature.asyncness.is_some() {
        return Err(Error::new_spanned(
            signature,
            "formatter functions cannot be async",
        ));
    }
    if matches!(&signature.safety, syn::Safety::Unsafe(_)) {
        return Err(Error::new_spanned(
            signature,
            "formatter functions cannot be unsafe",
        ));
    }
    if signature.abi.is_some() {
        return Err(Error::new_spanned(
            signature,
            "formatter functions cannot declare an extern ABI",
        ));
    }
    if signature.variadic.is_some() {
        return Err(Error::new_spanned(
            signature,
            "formatter functions cannot be variadic",
        ));
    }
    if !signature.generics.params.is_empty() || signature.generics.where_clause.is_some() {
        return Err(Error::new_spanned(
            &signature.generics,
            "formatter functions cannot be generic",
        ));
    }

    Ok(())
}

struct FormatterSignature {
    config_type: Option<Type>,
    config_mode: ConfigMode,
    ranges_mode: RangesMode,
    parameters: Vec<FormatterParameter>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FormatterParameter {
    Host,
    Source,
    Filename,
    ConfigDefault,
    ConfigOptional,
    RangesRequired,
    RangesOptional,
}

impl FormatterParameter {
    fn expression(&self) -> TokenStream2 {
        match self {
            Self::Host => quote!(&_bridge_host),
            Self::Source => quote!(_bridge_source),
            Self::Filename => quote!(_bridge_filename),
            Self::ConfigDefault => {
                quote!(_bridge_config.expect("Bridge resolved the default config"))
            }
            Self::ConfigOptional => quote!(_bridge_config),
            Self::RangesRequired => {
                quote!(_bridge_ranges.expect("Bridge validated the required ranges field"))
            }
            Self::RangesOptional => quote!(_bridge_ranges),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConfigMode {
    Unsupported,
    Default,
    Optional,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RangesMode {
    Unsupported,
    Optional,
    Required,
}

impl RangesMode {
    fn expression(self) -> TokenStream2 {
        match self {
            Self::Unsupported => quote!(::bridge::RangesMode::Unsupported),
            Self::Optional => quote!(::bridge::RangesMode::Optional),
            Self::Required => quote!(::bridge::RangesMode::Required),
        }
    }
}

impl FormatterSignature {
    fn from_function(function: &ItemFn) -> Result<Self> {
        let mut has_source = false;
        let mut config_type = None;
        let mut config_mode = ConfigMode::Unsupported;
        let mut ranges_mode = RangesMode::Unsupported;
        let mut parameters = Vec::with_capacity(function.sig.inputs.len());

        for argument in &function.sig.inputs {
            let FnArg::Typed(argument) = argument else {
                return Err(Error::new_spanned(
                    argument,
                    "formatter must be a free function",
                ));
            };
            let Pat::Ident(pattern) = argument.pat.as_ref() else {
                return Err(Error::new_spanned(
                    &argument.pat,
                    "formatter parameters must use the names `source`, `filename`, `config`, `ranges`, or `host`",
                ));
            };
            if pattern.by_ref.is_some() || pattern.mutability.is_some() || pattern.subpat.is_some()
            {
                return Err(Error::new_spanned(
                    &argument.pat,
                    "formatter parameters must be plain identifiers",
                ));
            }

            match pattern.ident.unraw().to_string().as_str() {
                "host" => {
                    require_type(
                        argument.ty.as_ref(),
                        is_host_reference,
                        "`host` must have type `&bridge::Host<'_>`",
                    )?;
                    parameters.push(FormatterParameter::Host);
                }
                "source" => {
                    require_type(
                        argument.ty.as_ref(),
                        is_str_reference,
                        "`source` must have type `&str`",
                    )?;
                    has_source = true;
                    parameters.push(FormatterParameter::Source);
                }
                "filename" => {
                    require_type(
                        argument.ty.as_ref(),
                        is_optional_str_reference,
                        "`filename` must have type `Option<&str>`",
                    )?;
                    parameters.push(FormatterParameter::Filename);
                }
                "config" => {
                    if let Some(inner_type) = immutable_reference_target(argument.ty.as_ref()) {
                        config_type = Some(inner_type.clone());
                        config_mode = ConfigMode::Default;
                        parameters.push(FormatterParameter::ConfigDefault);
                    } else if let Some(inner_type) =
                        optional_immutable_reference_target(argument.ty.as_ref())
                    {
                        config_type = Some(inner_type.clone());
                        config_mode = ConfigMode::Optional;
                        parameters.push(FormatterParameter::ConfigOptional);
                    } else {
                        return Err(Error::new_spanned(
                            &argument.ty,
                            "`config` must have type `&T` or `Option<&T>` where `T: bridge::Config`",
                        ));
                    }
                }
                "ranges" => {
                    if is_range_slice_reference(argument.ty.as_ref()) {
                        ranges_mode = RangesMode::Required;
                        parameters.push(FormatterParameter::RangesRequired);
                    } else if is_optional_range_slice_reference(argument.ty.as_ref()) {
                        ranges_mode = RangesMode::Optional;
                        parameters.push(FormatterParameter::RangesOptional);
                    } else {
                        return Err(Error::new_spanned(
                            &argument.ty,
                            "`ranges` must have type `&[Range<u32>]` or `Option<&[Range<u32>]>`",
                        ));
                    }
                }
                _ => {
                    return Err(Error::new_spanned(
                        &pattern.ident,
                        "unknown formatter parameter; expected `source`, `filename`, `config`, `ranges`, or `host`",
                    ));
                }
            }
        }

        if !has_source {
            return Err(Error::new_spanned(
                &function.sig.ident,
                "formatter function must have a `source: &str` parameter",
            ));
        }

        Ok(Self {
            config_type,
            config_mode,
            ranges_mode,
            parameters,
        })
    }
}

fn require_type(actual: &Type, predicate: impl FnOnce(&Type) -> bool, message: &str) -> Result<()> {
    if predicate(actual) {
        return Ok(());
    }

    Err(Error::new_spanned(actual, message))
}

fn is_host_reference(ty: &Type) -> bool {
    let Some(Type::Path(path)) = immutable_reference_target(ty) else {
        return false;
    };
    path.qself.is_none()
        && path
            .path
            .segments
            .last()
            .is_some_and(|part| part.ident == "Host")
}

fn is_str_reference(ty: &Type) -> bool {
    let Some(inner_type) = immutable_reference_target(ty) else {
        return false;
    };

    is_str(inner_type)
}

fn is_optional_str_reference(ty: &Type) -> bool {
    let Some(inner_type) = option_target(ty) else {
        return false;
    };

    is_str_reference(inner_type)
}

fn is_range_slice_reference(ty: &Type) -> bool {
    let Some(inner_type) = immutable_reference_target(ty) else {
        return false;
    };
    let Type::Slice(slice) = strip_type_wrappers(inner_type) else {
        return false;
    };

    is_range_u32(slice.elem.as_ref())
}

fn is_optional_range_slice_reference(ty: &Type) -> bool {
    let Some(inner_type) = option_target(ty) else {
        return false;
    };

    is_range_slice_reference(inner_type)
}

fn optional_immutable_reference_target(ty: &Type) -> Option<&Type> {
    let inner_type = option_target(ty)?;
    immutable_reference_target(inner_type)
}

fn option_target(ty: &Type) -> Option<&Type> {
    let Type::Path(type_path) = strip_type_wrappers(ty) else {
        return None;
    };
    if type_path.qself.is_some() || !is_option_path(&type_path.path) {
        return None;
    }
    let segment = type_path.path.segments.last()?;
    let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return None;
    };
    let mut arguments = arguments.args.iter();
    let GenericArgument::Type(inner_type) = arguments.next()? else {
        return None;
    };
    if arguments.next().is_some() {
        return None;
    }

    Some(strip_type_wrappers(inner_type))
}

fn is_range_u32(ty: &Type) -> bool {
    let Type::Path(type_path) = strip_type_wrappers(ty) else {
        return false;
    };
    if type_path.qself.is_some() || !is_range_path(&type_path.path) {
        return false;
    }
    let Some(segment) = type_path.path.segments.last() else {
        return false;
    };
    let PathArguments::AngleBracketed(arguments) = &segment.arguments else {
        return false;
    };
    let mut arguments = arguments.args.iter();
    let Some(GenericArgument::Type(inner_type)) = arguments.next() else {
        return false;
    };

    arguments.next().is_none() && is_u32(inner_type)
}

fn is_option_path(path: &syn::Path) -> bool {
    if path.segments.len() == 1 {
        return path
            .segments
            .first()
            .is_some_and(|segment| segment.ident == "Option");
    }
    if path.segments.len() != 3 {
        return false;
    }

    let mut segments = path.segments.iter();
    let root = segments.next().map(|segment| segment.ident.to_string());
    let module = segments.next().map(|segment| segment.ident.to_string());
    let name = segments.next().map(|segment| segment.ident.to_string());

    matches!(root.as_deref(), Some("std" | "core"))
        && module.as_deref() == Some("option")
        && name.as_deref() == Some("Option")
}

fn is_range_path(path: &syn::Path) -> bool {
    if path.segments.len() == 1 {
        return path
            .segments
            .first()
            .is_some_and(|segment| segment.ident == "Range");
    }
    if path.segments.len() != 3 {
        return false;
    }

    let mut segments = path.segments.iter();
    let root = segments.next().map(|segment| segment.ident.to_string());
    let module = segments.next().map(|segment| segment.ident.to_string());
    let name = segments.next().map(|segment| segment.ident.to_string());

    matches!(root.as_deref(), Some("std" | "core"))
        && module.as_deref() == Some("ops")
        && name.as_deref() == Some("Range")
}

fn immutable_reference_target(ty: &Type) -> Option<&Type> {
    let Type::Reference(reference) = strip_type_wrappers(ty) else {
        return None;
    };
    if reference.mutability.is_some() {
        return None;
    }

    Some(strip_type_wrappers(reference.elem.as_ref()))
}

fn is_str(ty: &Type) -> bool {
    let Type::Path(type_path) = strip_type_wrappers(ty) else {
        return false;
    };

    type_path.qself.is_none() && type_path.path.is_ident("str")
}

fn is_u32(ty: &Type) -> bool {
    let Type::Path(type_path) = strip_type_wrappers(ty) else {
        return false;
    };

    type_path.qself.is_none() && type_path.path.is_ident("u32")
}

fn strip_type_wrappers(mut ty: &Type) -> &Type {
    loop {
        match ty {
            Type::Group(group) => ty = group.elem.as_ref(),
            Type::Paren(paren) => ty = paren.elem.as_ref(),
            _ => return ty,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quote::quote;
    use syn::parse_quote;

    #[test]
    fn config_attribute_rejects_generics() {
        let generic: Item = parse_quote! {
            struct GenericOptions<T>(T);
        };

        assert!(expand_config(generic).is_err());
    }

    #[test]
    fn config_attribute_rejects_arguments_and_non_type_items() {
        let arguments = quote!(serde);
        let function = parse_quote! {
            fn options() {}
        };

        assert!(validate_config_attribute_arguments(&arguments).is_err());
        assert!(expand_config(function).is_err());
    }

    #[test]
    fn rejects_unknown_parameter_names() {
        let function = parse_quote! {
            fn format(input: &str) -> Result<String, String> {
                Ok(input.to_string())
            }
        };

        assert!(expand_formatter(function).is_err());
    }

    #[test]
    fn rejects_wrong_parameter_types() {
        let source = parse_quote! {
            fn format(source: String) -> Result<String, String> {
                Ok(source)
            }
        };
        let filename = parse_quote! {
            fn format(source: &str, filename: &str) -> Result<String, String> {
                Ok(format!("{filename}{source}"))
            }
        };
        let config = parse_quote! {
            fn format(source: &str, config: Options) -> Result<String, String> {
                todo!()
            }
        };
        let ranges = parse_quote! {
            fn format(source: &str, ranges: Vec<Range<u32>>) -> String {
                source.to_string()
            }
        };

        assert!(expand_formatter(source).is_err());
        assert!(expand_formatter(filename).is_err());
        assert!(expand_formatter(config).is_err());
        assert!(expand_formatter(ranges).is_err());
    }

    #[test]
    fn rejects_functions_without_source() {
        let function = parse_quote! {
            fn format(config: &Options) -> Result<String, String> {
                todo!()
            }
        };

        assert!(expand_formatter(function).is_err());
    }

    #[test]
    fn reports_attribute_arguments_as_unsupported() {
        let args = quote!(config = Options);
        assert!(validate_attribute_arguments(&args).is_err());
    }

    #[test]
    fn rejects_core_export_names() {
        for name in [
            "abi_version",
            "alloc",
            "reset",
            "register_config",
            "release_config",
            "output",
            "error",
        ] {
            let function: ItemFn = syn::parse_str(&format!(
                "fn {name}(source: &str) -> String {{ source.to_string() }}"
            ))
            .unwrap();
            assert!(expand_formatter(function).is_err());
        }
    }

    #[test]
    fn rejects_non_ascii_endpoint_names() {
        let function = parse_quote! {
            fn 格式化(source: &str) -> String {
                source.to_string()
            }
        };

        assert!(expand_formatter(function).is_err());
    }
}
