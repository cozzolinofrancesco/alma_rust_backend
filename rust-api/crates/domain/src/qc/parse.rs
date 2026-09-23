//! Tolerant parsing of the model responses for the three validation prompts.
//!
//! The prompts request JSON only, but models still occasionally wrap the object
//! in prose or ```` ```json ```` fences, so — like `rag_qc_handler`'s
//! `parseDataPointsFromResponse` port — we slice the first balanced JSON value out
//! of the text before deserializing, and read fields tolerantly (accepting the
//! prompt's SCREAMING keys plus snake/camel aliases). A response whose verdict
//! cannot be parsed is reported as an error so the caller records the claim as
//! `not_assessed` (paper §3.6 / §5.3) rather than inventing a verdict.

use serde_json::Value;

use super::dto::{Claim, Evidence, Judgment, Status};

/// Every balanced, *parseable* JSON object/array sliced from `text`, in order.
///
/// Scans from each `{`/`[` to its matching close (respecting string literals and
/// escapes). A span that fails to parse is skipped and scanning resumes just past
/// its opening bracket, so a leading prose aside containing an invalid-JSON
/// bracket (e.g. `Here are the claims [as requested]: {...}`) does not abort the
/// search. Concatenated values (e.g. an echoed example object followed by the
/// real payload) are all returned so callers can pick the right one.
fn extract_json_values(text: &str) -> Vec<Value> {
    let bytes = text.as_bytes();
    let mut values = Vec::new();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let Some(relative_start) = bytes[cursor..]
            .iter()
            .position(|&byte| byte == b'{' || byte == b'[')
        else {
            break;
        };
        let start = cursor + relative_start;
        let open_byte = bytes[start];
        let close_byte = if open_byte == b'{' { b'}' } else { b']' };

        let mut depth: i32 = 0;
        let mut inside_string = false;
        let mut escaped = false;
        let mut end: Option<usize> = None;
        for index in start..bytes.len() {
            let byte = bytes[index];
            if inside_string {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    inside_string = false;
                }
                continue;
            }
            if byte == b'"' {
                inside_string = true;
            } else if byte == open_byte {
                depth += 1;
            } else if byte == close_byte {
                depth -= 1;
                if depth == 0 {
                    end = Some(index);
                    break;
                }
            }
        }

        match end {
            // Opening/closing brackets and quotes are ASCII, so `start`/`end` fall
            // on char boundaries and byte-slicing is safe.
            Some(end_index) => match serde_json::from_str::<Value>(&text[start..=end_index]) {
                Ok(value) => {
                    values.push(value);
                    cursor = end_index + 1;
                }
                // Unparseable span: resume past this opening bracket, not past the
                // (possibly premature) close, so a later valid value is still found.
                Err(_) => cursor = start + 1,
            },
            // No matching close for this bracket; skip it and keep scanning.
            None => cursor = start + 1,
        }
    }
    values
}

/// Slice the first balanced, parseable JSON object/array out of `text`. Handles
/// leading prose and code fences, and (unlike a naive first-bracket scan) skips a
/// leading invalid-JSON bracket span to find a later valid value.
pub fn extract_json(text: &str) -> Option<Value> {
    extract_json_values(text).into_iter().next()
}

/// Look up `field` in an object case-insensitively (ASCII), mirroring the
/// case-tolerance the item-key readers already apply. Returns the first matching
/// value, or `None` when `value` is not an object or the key is absent.
fn get_field_ignore_ascii_case<'a>(value: &'a Value, field: &str) -> Option<&'a Value> {
    value
        .as_object()?
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(field))
        .map(|(_, found)| found)
}

/// Pick the candidate that actually carries the `field` array (case-insensitive)
/// or is a bare top-level array; otherwise the first candidate. This skips an
/// echoed example / prose object that lacks the expected container.
fn pick_container_value(values: &[Value], field: &str) -> Option<Value> {
    values
        .iter()
        .find(|value| {
            get_field_ignore_ascii_case(value, field)
                .and_then(Value::as_array)
                .is_some()
                || value.is_array()
        })
        .or_else(|| values.first())
        .cloned()
}

/// First non-empty string among `keys` in `object`. A numeric value is stringified
/// (so a `SOURCE_PAGE: 3` still reads as `"3"` when a string is wanted).
fn first_string(object: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        match object.get(*key) {
            Some(Value::String(text)) if !text.trim().is_empty() => return Some(text.clone()),
            Some(Value::Number(number)) => return Some(number.to_string()),
            _ => {}
        }
    }
    None
}

/// First non-null value among `keys` in `object`, cloned.
fn first_value(object: &Value, keys: &[&str]) -> Option<Value> {
    for key in keys {
        match object.get(*key) {
            Some(value) if !value.is_null() => return Some(value.clone()),
            _ => {}
        }
    }
    None
}

/// Pull the item array out of a `{ "<field>": [...] }` object (matching `field`
/// case-insensitively, so an uppercased container like `{"CLAIMS": [...]}` is not
/// silently read as zero items), or accept a bare top-level array.
fn items_array(value: &Value, field: &str) -> Vec<Value> {
    get_field_ignore_ascii_case(value, field)
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| value.as_array().cloned())
        .unwrap_or_default()
}

/// Parse Prompt 1's output into atomic claims. Entries without checkable text are
/// skipped; an empty `{"claims": []}` is a valid, empty result (paper §3.6:
/// distinct from a failed extraction). Returns `Err` only when no JSON could be
/// sliced from the response at all.
pub fn parse_claims(text: &str) -> Result<Vec<Claim>, String> {
    let values = extract_json_values(text);
    let value = pick_container_value(&values, "claims")
        .ok_or("no JSON value found in the extraction response")?;
    let mut claims = Vec::new();
    for item in items_array(&value, "claims") {
        let Some(claim_text) = first_string(&item, &["CLAIM_TEXT", "claim_text", "claimText", "claim", "text"])
        else {
            continue;
        };
        let claim_ref = first_string(&item, &["CLAIM_REF", "claim_ref", "claimRef", "ref"]);
        let source_page = first_value(&item, &["SOURCE_PAGE", "source_page", "sourcePage", "page"]);
        claims.push(Claim {
            claim_text,
            claim_ref,
            source_page,
        });
    }
    Ok(claims)
}

/// Parse Prompt 2's output into evidence passages. Entries without a quote are
/// skipped; a missing `source_id` falls back to `default_source_id` (the supplied
/// source identifier). An empty `{"evidence": []}` yields an empty list, which the
/// caller treats as an evidence gap.
pub fn parse_evidence(text: &str, default_source_id: &str) -> Result<Vec<Evidence>, String> {
    let values = extract_json_values(text);
    let value = pick_container_value(&values, "evidence")
        .ok_or("no JSON value found in the evidence response")?;
    let mut evidence = Vec::new();
    for item in items_array(&value, "evidence") {
        let Some(quote) = first_string(&item, &["quote", "QUOTE", "text", "passage"]) else {
            continue;
        };
        let source_id = first_string(&item, &["source_id", "sourceId", "SOURCE_ID"])
            .unwrap_or_else(|| default_source_id.to_string());
        let location = first_string(&item, &["location", "LOCATION", "page"]);
        evidence.push(Evidence {
            quote,
            source_id,
            location,
        });
    }
    Ok(evidence)
}

/// Parse Prompt 3's output into a judgment. Requires a recognizable `STATUS`
/// (`Err` otherwise → the caller records `not_assessed`). Missing optional fields
/// default conservatively; `insufficient_evidence` defaults to `true` for a
/// `SOURCE_NOT_FOUND` verdict when the flag is absent.
pub fn parse_judgment(text: &str) -> Result<Judgment, String> {
    let values = extract_json_values(text);
    if values.is_empty() {
        return Err("no JSON value found in the judgment response".to_string());
    }
    // Prefer the LAST candidate that actually carries a STATUS field: Prompt 3
    // embeds an example object ({"STATUS":"SOURCE_NOT_FOUND",...}) and models
    // routinely echo it before emitting their real determination, so an earlier
    // STATUS-bearing object may be that example rather than the verdict. Fall
    // back to the last candidate so the "no STATUS field" error still fires.
    let value = values
        .iter()
        .rev()
        .find(|candidate| first_string(candidate, &["STATUS", "status"]).is_some())
        .or_else(|| values.last())
        .cloned()
        .expect("values is non-empty");

    let status_token = first_string(&value, &["STATUS", "status"])
        .ok_or("the judgment response carried no STATUS field")?;
    let status = Status::from_wire(&status_token)
        .ok_or_else(|| format!("the judgment STATUS '{status_token}' is not a permitted verdict"))?;

    let rationale = first_string(&value, &["RATIONALE", "rationale"]).unwrap_or_default();
    let rag_quote = first_string(&value, &["RAG_QUOTE", "ragQuote", "rag_quote"])
        .filter(|quote| !quote.is_empty());
    let rag_location = first_string(&value, &["RAG_LOCATION", "ragLocation", "rag_location"]);

    let contradiction_present = first_bool(&value, &["CONTRADICTION_PRESENT", "contradictionPresent"])
        .unwrap_or(status == Status::NotMatching);
    let insufficient_evidence = first_bool(&value, &["INSUFFICIENT_EVIDENCE", "insufficientEvidence"])
        .unwrap_or(status == Status::SourceNotFound);

    Ok(Judgment {
        status,
        rationale,
        rag_quote,
        rag_location,
        contradiction_present,
        insufficient_evidence,
    })
}

/// First boolean among `keys` in `object` (accepts a literal bool or the strings
/// `"true"`/`"false"`).
fn first_bool(object: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        match object.get(*key) {
            Some(Value::Bool(flag)) => return Some(*flag),
            Some(Value::String(text)) => match text.trim().to_ascii_lowercase().as_str() {
                "true" => return Some(true),
                "false" => return Some(false),
                _ => {}
            },
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_json_slices_out_of_prose_and_fences() {
        let text = "Sure, here is the JSON:\n```json\n{\"claims\": []}\n```\nThanks!";
        let value = extract_json(text).expect("slices the object");
        assert_eq!(value, serde_json::json!({"claims": []}));
    }

    #[test]
    fn extract_json_ignores_braces_inside_strings() {
        let text = r#"{"claims": [{"CLAIM_TEXT": "a } b { c"}]}"#;
        let value = extract_json(text).expect("balanced despite braces in string");
        assert_eq!(value["claims"][0]["CLAIM_TEXT"], serde_json::json!("a } b { c"));
    }

    #[test]
    fn parse_claims_reads_screaming_keys_and_skips_empty() {
        let text = r#"{"claims":[
            {"CLAIM_TEXT":"Method B processed ten files in fifteen minutes","CLAIM_REF":"[1]","SOURCE_PAGE":2},
            {"CLAIM_TEXT":"   "},
            {"CLAIM_REF":"[2]"}
        ]}"#;
        let claims = parse_claims(text).expect("parses");
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].claim_text, "Method B processed ten files in fifteen minutes");
        assert_eq!(claims[0].claim_ref.as_deref(), Some("[1]"));
        assert_eq!(claims[0].source_page, Some(serde_json::json!(2)));
    }

    #[test]
    fn parse_claims_accepts_empty_list() {
        assert!(parse_claims(r#"{"claims": []}"#).unwrap().is_empty());
    }

    #[test]
    fn parse_claims_errors_when_no_json() {
        assert!(parse_claims("the model refused").is_err());
    }

    #[test]
    fn parse_claims_skips_invalid_leading_bracket_span() {
        // A prose aside contains an invalid-JSON bracket ("[as requested]") before
        // the real payload; the scanner must skip it and still parse the claims.
        let text = "Here are the claims [as requested]:\n```json\n{\"claims\":[{\"CLAIM_TEXT\":\"A is 5\"}]}\n```";
        let claims = parse_claims(text).expect("parses past the invalid leading span");
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].claim_text, "A is 5");
    }

    #[test]
    fn parse_claims_reads_uppercased_container_key() {
        // Item keys already tolerate casing; the container key must too, else an
        // uppercased container silently yields zero claims (a false "clean" result).
        let claims = parse_claims(r#"{"CLAIMS":[{"CLAIM_TEXT":"A is 5"}]}"#).expect("parses");
        assert_eq!(claims.len(), 1);
    }

    #[test]
    fn parse_judgment_prefers_real_verdict_over_echoed_example() {
        // The model echoes Prompt 3's SOURCE_NOT_FOUND example, then emits its real
        // NOT_MATCHING verdict. The real (last STATUS-bearing) verdict must win.
        let text = concat!(
            "Following the example {\"STATUS\":\"SOURCE_NOT_FOUND\",\"RATIONALE\":\"example\"}, ",
            "my determination is:\n{\"STATUS\":\"NOT_MATCHING\",\"RATIONALE\":\"value differs\"}"
        );
        let judgment = parse_judgment(text).expect("parses");
        assert_eq!(judgment.status, Status::NotMatching);
        assert_eq!(judgment.rationale, "value differs");
    }

    #[test]
    fn parse_evidence_defaults_missing_source_id() {
        let text = r#"{"evidence":[{"quote":"A is 5"},{"quote":"","source_id":"x"}]}"#;
        let evidence = parse_evidence(text, "doc-1").expect("parses");
        assert_eq!(evidence.len(), 1);
        assert_eq!(evidence[0].quote, "A is 5");
        assert_eq!(evidence[0].source_id, "doc-1");
    }

    #[test]
    fn parse_judgment_reads_verdict_and_flags() {
        let text = r#"{"STATUS":"NOT_MATCHING","RATIONALE":"value differs","RAG_QUOTE":"A is 6","RAG_LOCATION":null,"CONTRADICTION_PRESENT":true,"INSUFFICIENT_EVIDENCE":false}"#;
        let judgment = parse_judgment(text).expect("parses");
        assert_eq!(judgment.status, Status::NotMatching);
        assert_eq!(judgment.rationale, "value differs");
        assert_eq!(judgment.rag_quote.as_deref(), Some("A is 6"));
        assert!(judgment.contradiction_present);
        assert!(!judgment.insufficient_evidence);
    }

    #[test]
    fn parse_judgment_defaults_insufficient_flag_for_source_not_found() {
        let text = r#"{"STATUS":"SOURCE_NOT_FOUND","RATIONALE":"absent","RAG_QUOTE":""}"#;
        let judgment = parse_judgment(text).expect("parses");
        assert_eq!(judgment.status, Status::SourceNotFound);
        assert!(judgment.insufficient_evidence);
        assert_eq!(judgment.rag_quote, None);
    }

    #[test]
    fn parse_judgment_rejects_unknown_status() {
        let text = r#"{"STATUS":"MAYBE","RATIONALE":"unsure"}"#;
        assert!(parse_judgment(text).is_err());
    }
}
