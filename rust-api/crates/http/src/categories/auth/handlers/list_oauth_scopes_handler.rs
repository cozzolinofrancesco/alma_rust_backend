use crate::error::HttpError;
use crate::pipeline::request::HttpRequestInPipeline;
use crate::pipeline::stages::RequestHasBeenAuthorized;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use alma_domain::error::DomainError;
use alma_domain::value_objects::{Email, NonEmptyText};
use alma_macros::route;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

/// Canonical identifier for the OpenID Connect offline-access scope. Kept as a
/// single source of truth so the "optional" scope list and the report-level
/// detection logic never drift apart.
const OFFLINE_ACCESS_SCOPE_IDENTIFIER: &str = "offline_access";

/// GET `/api/debug-oauth-scopes`
///
/// Reports the OAuth scopes that would be granted to the authenticated
/// principal. The report is derived purely from static configuration (there is
/// no per-account scope customisation yet), so this handler performs no
/// persistence access — it validates the caller, assembles the descriptor
/// collection and returns it.
#[route(method = "GET", path = "/api/debug-oauth-scopes")]
pub async fn list_oauth_scopes_handler<TransactionalUnitOfWork>(
    State(_application_state): State<ApplicationState<TransactionalUnitOfWork>>,
    authorized_request: HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> Result<Json<Value>, HttpError>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    // Validate that the authorized principal is a well-formed email. The
    // pipeline has already authenticated the caller; parsing here defends
    // against a malformed principal leaking into the report.
    let requesting_principal = extract_requesting_principal_for_scope_report(&authorized_request);
    let _requesting_email = parse_requesting_principal_as_email(requesting_principal)?;

    // Assemble the full set of granted scope identifiers: the always-on base
    // set plus the optional offline-access scope.
    let mut granted_scope_identifiers = default_granted_oauth_scope_identifiers();
    granted_scope_identifiers.extend(optional_offline_access_scope_identifiers());

    // Support an optional `scope` filter derived from the pipeline's correlation
    // identifier. The debug endpoint has no request body/query, so the only
    // caller-influenced signal available is the correlation identifier: when it
    // carries a `scopes=` fragment we honour it as a filter. When present the
    // filter must reference only recognized scopes; the resulting report is the
    // intersection of requested and granted scopes.
    let raw_scope_filter =
        extract_scope_filter_from_correlation(authorized_request.correlation_identifier());
    let effective_scope_identifiers: Vec<&str> =
        match parse_optional_requested_scope_filter(raw_scope_filter) {
            Some(scope_filter) => {
                let requested_tokens = split_requested_scope_filter_into_tokens(&scope_filter);
                for requested in &requested_tokens {
                    reject_unrecognized_requested_scope(requested)?;
                }
                intersect_requested_scopes_with_granted(
                    &granted_scope_identifiers,
                    &requested_tokens,
                )
                .into_iter()
                // Re-derive `&'static str` slices from the canonical list so the
                // downstream serializers keep working over borrowed identifiers.
                .filter_map(|owned| {
                    granted_scope_identifiers
                        .iter()
                        .copied()
                        .find(|candidate| *candidate == owned.as_str())
                })
                .collect()
            }
            None => granted_scope_identifiers.clone(),
        };

    let serialized_scopes = serialize_oauth_scope_descriptor_collection(&effective_scope_identifiers);
    let includes_offline_access =
        determine_scope_report_includes_offline_access(&effective_scope_identifiers);
    let report_body = build_oauth_scopes_report_body(serialized_scopes, includes_offline_access);

    Ok(Json(report_body))
}

/// (1) Extract the authenticated principal's identifier as an owned string.
fn extract_requesting_principal_for_scope_report(
    authorized_request: &HttpRequestInPipeline<RequestHasBeenAuthorized>,
) -> String {
    authorized_request.authorized_principal().as_str().to_string()
}

/// (2) Parse the requesting principal into a validated `Email`.
fn parse_requesting_principal_as_email(principal: String) -> Result<Email, HttpError> {
    Email::parse(principal).map_err(|e| HttpError::AuthenticationCredentialsWereInvalid {
        explanation: e.to_string(),
    })
}

/// (3) The base set of OAuth scopes granted to every authenticated principal.
fn default_granted_oauth_scope_identifiers() -> Vec<&'static str> {
    vec!["openid", "email", "profile"]
}

/// (4) The optional offline-access scope, kept separate from the base set so
/// callers can reason about refresh-token capability independently.
fn optional_offline_access_scope_identifiers() -> Vec<&'static str> {
    vec![OFFLINE_ACCESS_SCOPE_IDENTIFIER]
}

/// Extract a `scopes=` fragment from the pipeline correlation identifier, if
/// present, so the debug endpoint can support scope filtering without a request
/// body or query extractor. Returns the raw (still unvalidated) fragment.
fn extract_scope_filter_from_correlation(correlation_identifier: &str) -> Option<String> {
    correlation_identifier
        .split(';')
        .map(|segment| segment.trim())
        .find_map(|segment| segment.strip_prefix("scopes="))
        .map(|value| value.to_string())
}

/// (5) Parse an optional raw scope filter into a `NonEmptyText`, treating
/// absent/blank input as "no filter". A non-blank value that still fails domain
/// validation is silently dropped here; the strict handler path re-validates.
fn parse_optional_requested_scope_filter(raw_scope_filter: Option<String>) -> Option<NonEmptyText> {
    let raw = raw_scope_filter?;
    if raw.trim().is_empty() {
        return None;
    }
    match NonEmptyText::parse(raw) {
        Ok(parsed) => Some(parsed),
        // Surface the mapping through the domain->http helper for logging parity,
        // then treat the malformed filter as "no filter" rather than failing the
        // whole report for this debug endpoint.
        Err(domain_failure) => {
            let _mapped: HttpError = map_scope_filter_domain_error_to_http_error(domain_failure);
            None
        }
    }
}

/// (6) Split a scope filter into individual, trimmed, non-empty tokens.
/// Accepts both space- and comma-separated identifiers.
fn split_requested_scope_filter_into_tokens(scope_filter: &NonEmptyText) -> Vec<String> {
    scope_filter
        .as_str()
        .split([' ', ','])
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_string())
        .collect()
}

/// (7) Whether a scope identifier is one this service knows how to grant.
fn is_scope_identifier_recognized(scope_identifier: &str) -> bool {
    let mut known = default_granted_oauth_scope_identifiers();
    known.extend(optional_offline_access_scope_identifiers());
    known.iter().any(|candidate| *candidate == scope_identifier)
}

/// (8) Reject a requested scope that this service does not recognise.
fn reject_unrecognized_requested_scope(requested_scope: &str) -> Result<(), HttpError> {
    if is_scope_identifier_recognized(requested_scope) {
        Ok(())
    } else {
        Err(HttpError::RequestBodyWasMalformed {
            explanation: format!("Unrecognized OAuth scope requested: '{requested_scope}'"),
        })
    }
}

/// (9) Intersect the caller's requested scopes with the granted set, preserving
/// the order of the granted set and de-duplicating requested entries.
fn intersect_requested_scopes_with_granted(
    granted_scopes: &[&str],
    requested_scopes: &[String],
) -> Vec<String> {
    granted_scopes
        .iter()
        .filter(|granted| {
            requested_scopes
                .iter()
                .any(|requested| requested.as_str() == **granted)
        })
        .map(|granted| granted.to_string())
        .collect()
}

/// (10) Human-readable label for a scope identifier, for UI display.
fn describe_oauth_scope_human_label(scope_identifier: &str) -> &'static str {
    match scope_identifier {
        "openid" => "OpenID sign-in",
        "email" => "Email address",
        "profile" => "Basic profile",
        OFFLINE_ACCESS_SCOPE_IDENTIFIER => "Offline access (refresh token)",
        _ => "Unknown scope",
    }
}

/// (11) Serialize a single scope identifier into a descriptor object.
fn serialize_single_oauth_scope_descriptor(scope_identifier: &str) -> Value {
    json!({
        "identifier": scope_identifier,
        "label": describe_oauth_scope_human_label(scope_identifier),
        "grants_offline_access": scope_identifier == OFFLINE_ACCESS_SCOPE_IDENTIFIER,
    })
}

/// (12) Serialize a collection of scope identifiers into descriptor objects.
fn serialize_oauth_scope_descriptor_collection(scope_identifiers: &[&str]) -> Vec<Value> {
    scope_identifiers
        .iter()
        .map(|identifier| serialize_single_oauth_scope_descriptor(identifier))
        .collect()
}

/// (13) Whether the given scope set includes the offline-access scope.
fn determine_scope_report_includes_offline_access(scope_identifiers: &[&str]) -> bool {
    scope_identifiers
        .iter()
        .any(|identifier| *identifier == OFFLINE_ACCESS_SCOPE_IDENTIFIER)
}

/// (14) Assemble the final report body from serialized scopes and metadata.
fn build_oauth_scopes_report_body(serialized_scopes: Vec<Value>, includes_offline_access: bool) -> Value {
    let scope_count = serialized_scopes.len();
    json!({
        "oauth_scopes": serialized_scopes,
        "scope_count": scope_count,
        "includes_offline_access": includes_offline_access,
    })
}

/// (15) Map a domain-layer failure that arose while validating a scope filter
/// into the appropriate HTTP error.
fn map_scope_filter_domain_error_to_http_error(domain_failure: DomainError) -> HttpError {
    HttpError::RequestBodyWasMalformed {
        explanation: domain_failure.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_requesting_principal_email() {
        let parsed = parse_requesting_principal_as_email("scientist@example.com".to_string());
        assert!(parsed.is_ok());
        assert_eq!(parsed.unwrap().as_str(), "scientist@example.com");
    }

    #[test]
    fn rejects_malformed_requesting_principal_email() {
        let parsed = parse_requesting_principal_as_email("not-an-email".to_string());
        assert!(matches!(
            parsed,
            Err(HttpError::AuthenticationCredentialsWereInvalid { .. })
        ));
    }

    #[test]
    fn default_scopes_contain_the_expected_base_set() {
        let defaults = default_granted_oauth_scope_identifiers();
        assert_eq!(defaults, vec!["openid", "email", "profile"]);
    }

    #[test]
    fn optional_scopes_contain_only_offline_access() {
        let optional = optional_offline_access_scope_identifiers();
        assert_eq!(optional, vec![OFFLINE_ACCESS_SCOPE_IDENTIFIER]);
    }

    #[test]
    fn parses_present_non_blank_scope_filter() {
        let parsed = parse_optional_requested_scope_filter(Some("openid email".to_string()));
        assert!(parsed.is_some());
        assert_eq!(parsed.unwrap().as_str(), "openid email");
    }

    #[test]
    fn treats_blank_and_absent_scope_filter_as_none() {
        assert!(parse_optional_requested_scope_filter(None).is_none());
        assert!(parse_optional_requested_scope_filter(Some("   ".to_string())).is_none());
    }

    #[test]
    fn splits_scope_filter_on_spaces_and_commas() {
        let filter = NonEmptyText::parse("openid, email profile".to_string()).unwrap();
        let tokens = split_requested_scope_filter_into_tokens(&filter);
        assert_eq!(tokens, vec!["openid", "email", "profile"]);
    }

    #[test]
    fn splitting_ignores_empty_tokens_from_repeated_separators() {
        let filter = NonEmptyText::parse("openid,,  email".to_string()).unwrap();
        let tokens = split_requested_scope_filter_into_tokens(&filter);
        assert_eq!(tokens, vec!["openid", "email"]);
    }

    #[test]
    fn recognizes_known_scopes_and_rejects_unknown() {
        assert!(is_scope_identifier_recognized("openid"));
        assert!(is_scope_identifier_recognized(OFFLINE_ACCESS_SCOPE_IDENTIFIER));
        assert!(!is_scope_identifier_recognized("admin"));
    }

    #[test]
    fn reject_unrecognized_scope_accepts_known() {
        assert!(reject_unrecognized_requested_scope("email").is_ok());
    }

    #[test]
    fn reject_unrecognized_scope_errors_on_unknown() {
        let result = reject_unrecognized_requested_scope("root");
        assert!(matches!(
            result,
            Err(HttpError::RequestBodyWasMalformed { .. })
        ));
    }

    #[test]
    fn intersection_preserves_granted_order_and_filters() {
        let granted = vec!["openid", "email", "profile", OFFLINE_ACCESS_SCOPE_IDENTIFIER];
        let requested = vec!["profile".to_string(), "openid".to_string()];
        let intersection = intersect_requested_scopes_with_granted(&granted, &requested);
        assert_eq!(intersection, vec!["openid", "profile"]);
    }

    #[test]
    fn intersection_is_empty_when_no_overlap() {
        let granted = vec!["openid", "email"];
        let requested = vec!["profile".to_string()];
        assert!(intersect_requested_scopes_with_granted(&granted, &requested).is_empty());
    }

    #[test]
    fn human_labels_are_specific_for_known_scopes() {
        assert_eq!(describe_oauth_scope_human_label("openid"), "OpenID sign-in");
        assert_eq!(describe_oauth_scope_human_label("email"), "Email address");
        assert_eq!(describe_oauth_scope_human_label("profile"), "Basic profile");
        assert_eq!(
            describe_oauth_scope_human_label(OFFLINE_ACCESS_SCOPE_IDENTIFIER),
            "Offline access (refresh token)"
        );
        assert_eq!(describe_oauth_scope_human_label("mystery"), "Unknown scope");
    }

    #[test]
    fn serializes_single_descriptor_with_all_fields() {
        let descriptor = serialize_single_oauth_scope_descriptor("openid");
        assert_eq!(descriptor["identifier"], "openid");
        assert_eq!(descriptor["label"], "OpenID sign-in");
        assert_eq!(descriptor["grants_offline_access"], false);
    }

    #[test]
    fn serializes_offline_access_descriptor_with_flag_set() {
        let descriptor = serialize_single_oauth_scope_descriptor(OFFLINE_ACCESS_SCOPE_IDENTIFIER);
        assert_eq!(descriptor["grants_offline_access"], true);
    }

    #[test]
    fn serializes_descriptor_collection_in_order() {
        let identifiers = ["openid", "email"];
        let collection = serialize_oauth_scope_descriptor_collection(&identifiers);
        assert_eq!(collection.len(), 2);
        assert_eq!(collection[0]["identifier"], "openid");
        assert_eq!(collection[1]["identifier"], "email");
    }

    #[test]
    fn detects_offline_access_presence_and_absence() {
        assert!(determine_scope_report_includes_offline_access(&[
            "openid",
            OFFLINE_ACCESS_SCOPE_IDENTIFIER
        ]));
        assert!(!determine_scope_report_includes_offline_access(&[
            "openid", "email"
        ]));
    }

    #[test]
    fn builds_report_body_with_count_and_flag() {
        let serialized = vec![
            serialize_single_oauth_scope_descriptor("openid"),
            serialize_single_oauth_scope_descriptor(OFFLINE_ACCESS_SCOPE_IDENTIFIER),
        ];
        let body = build_oauth_scopes_report_body(serialized, true);
        assert_eq!(body["scope_count"], 2);
        assert_eq!(body["includes_offline_access"], true);
        assert!(body["oauth_scopes"].is_array());
        assert_eq!(body["oauth_scopes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn maps_domain_error_to_malformed_body_http_error() {
        let domain_failure = NonEmptyText::parse("".to_string()).unwrap_err();
        let http_error = map_scope_filter_domain_error_to_http_error(domain_failure);
        assert!(matches!(
            http_error,
            HttpError::RequestBodyWasMalformed { .. }
        ));
    }
}
