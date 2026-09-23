#![allow(clippy::collapsible_if)]

use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::punctuated::Punctuated;
use syn::{Expr, ExprLit, ItemFn, ItemStruct, Lit, Meta, MetaNameValue, Token, parse_macro_input};

fn extract_string_literal_named(
    parsed_arguments: &Punctuated<Meta, Token![,]>,
    requested_argument_name: &str,
) -> Option<String> {
    for individual_argument in parsed_arguments.iter() {
        if let Meta::NameValue(MetaNameValue {
            path: argument_path,
            value:
                Expr::Lit(ExprLit {
                    lit: Lit::Str(string_literal),
                    ..
                }),
            ..
        }) = individual_argument
        {
            if argument_path.is_ident(requested_argument_name) {
                return Some(string_literal.value());
            }
        }
    }
    None
}

#[proc_macro_attribute]
pub fn route(attribute_arguments: TokenStream, annotated_item: TokenStream) -> TokenStream {
    let parsed_arguments = parse_macro_input!(
        attribute_arguments with Punctuated::<Meta, Token![,]>::parse_terminated
    );
    let annotated_function = parse_macro_input!(annotated_item as ItemFn);

    let resolved_http_method = extract_string_literal_named(&parsed_arguments, "method")
        .unwrap_or_else(|| String::from("GET"));
    let resolved_url_path = extract_string_literal_named(&parsed_arguments, "path")
        .unwrap_or_else(|| String::from("/"));

    let annotated_function_identifier = annotated_function.sig.ident.clone();
    let descriptor_function_identifier =
        format_ident!("{}_route_descriptor", annotated_function_identifier);

    let generated_output = quote! {
        #annotated_function

        pub fn #descriptor_function_identifier() -> (&'static str, &'static str) {
            (#resolved_http_method, #resolved_url_path)
        }
    };

    generated_output.into()
}

#[proc_macro_attribute]
pub fn use_case(attribute_arguments: TokenStream, annotated_item: TokenStream) -> TokenStream {
    let parsed_arguments = parse_macro_input!(
        attribute_arguments with Punctuated::<Meta, Token![,]>::parse_terminated
    );
    let annotated_structure = parse_macro_input!(annotated_item as ItemStruct);

    let resolved_use_case_label = extract_string_literal_named(&parsed_arguments, "name")
        .unwrap_or_else(|| String::from("unnamed-use-case"));

    let annotated_structure_identifier = annotated_structure.ident.clone();
    let (implementation_generics, type_generics, where_clause) =
        annotated_structure.generics.split_for_impl();

    let generated_output = quote! {
        #annotated_structure

        impl #implementation_generics #annotated_structure_identifier #type_generics #where_clause {
            pub fn use_case_label() -> &'static str {
                #resolved_use_case_label
            }
        }
    };

    generated_output.into()
}
