//! Canonical-JSON hashing for the agent-execution engine (`planHash` and friends).
//!
//! Ported from `frontend_v3/app/lib/agentExecution/hash.server.ts`
//! (`canonicalValue` / `hashValue` / `hashBytes`). Parity note (see the port
//! plan's "Parity requirements"): this is **Rust-only self-consistency** — both
//! the create side (`runs/plan`) and the verify side (`runs/advance`) compute the
//! digest through this same `serde_json::Value` path, so no byte-parity with the
//! JS `JSON.stringify` output is required or attempted.
//!
//! Canonicalization rules (must match the reference and stay stable across
//! versions, or every `runs/advance` would 409 on a `planHash` mismatch):
//! - object keys are sorted **ascending**, recursively;
//! - array order is **preserved**;
//! - scalars are emitted unchanged.
//!
//! The digest is the SHA-256, lowercase-hex-encoded, of the **compact** JSON
//! (no whitespace) produced by serializing the canonicalized value.

use std::fmt::Write as _;
use std::hash::Hash;

use indexmap::IndexSet;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Recursively canonicalize a JSON value: sort object keys ascending, preserve
/// array order, leave scalars untouched.
///
/// Mirrors `canonicalValue` in `hash.server.ts`. Sorting is byte-wise on the
/// UTF-8 key bytes; for the ASCII identifiers used by the engine this coincides
/// with the reference's code-unit comparison, and Rust-internal consistency is
/// all that is required here.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.as_str().cmp(right.as_str()));
            let mut canonical = Map::with_capacity(entries.len());
            for (key, entry) in entries {
                canonical.insert(key.clone(), canonicalize(entry));
            }
            Value::Object(canonical)
        }
        other => other.clone(),
    }
}

/// SHA-256 of a canonicalized `serde_json::Value`, lowercase hex.
///
/// This is the `planHash` workhorse: the caller strips the `planHash` field from
/// the plan, hands the remaining `Value` here, and stores the result. It is
/// infallible — serializing a `serde_json::Value` to compact JSON cannot fail
/// (object keys are always strings and `Number` never holds NaN/Infinity).
pub fn hash_canonical_json(value: &Value) -> String {
    let compact = serde_json::to_string(&canonicalize(value))
        .expect("serializing a serde_json::Value to compact JSON is infallible");
    sha256_hex(compact.as_bytes())
}

/// SHA-256 of the canonical, compact JSON encoding of any `Serialize` value,
/// lowercase hex. Mirrors `hashValue<T>` in `hash.server.ts`.
///
/// Fails only if `value` cannot be represented as JSON (e.g. a map with
/// non-string keys); for the engine DTOs and `Value` inputs this never happens.
pub fn hash_value<T>(value: &T) -> Result<String, serde_json::Error>
where
    T: Serialize + ?Sized,
{
    let as_value = serde_json::to_value(value)?;
    Ok(hash_canonical_json(&as_value))
}

/// SHA-256 of raw bytes, lowercase hex. Mirrors `hashBytes` in
/// `hash.server.ts`; used for supplied-file / digest verification.
pub fn hash_bytes(value: &[u8]) -> String {
    sha256_hex(value)
}

/// Lowercase-hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        // `{:02x}` keeps leading zeros — omitting the width would corrupt the digest.
        write!(hex, "{byte:02x}").expect("writing hex into a String is infallible");
    }
    hex
}

/// Order-preserving dedup: keep the **first** occurrence of each item and drop
/// later duplicates, preserving first-seen order.
///
/// Backed by `IndexSet` (not `BTreeSet`) — the engine relies on insertion order
/// for `plan.order` and `dependencies` (see the port plan's `runs/plan`
/// "order-preserving dedup — IndexSet, not BTreeSet").
pub fn dedup_preserving_order<T, I>(items: I) -> Vec<T>
where
    I: IntoIterator<Item = T>,
    T: Eq + Hash,
{
    items.into_iter().collect::<IndexSet<T>>().into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Known SHA-256 vectors (verified with the system `shasum -a 256`):
    // the classic FIPS-180-2 "abc" vector and the empty-string vector.
    const SHA256_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const SHA256_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(sha256_hex(b"abc"), SHA256_ABC);
        assert_eq!(sha256_hex(b""), SHA256_EMPTY);
        assert_eq!(hash_bytes(b"abc"), SHA256_ABC);
    }

    #[test]
    fn hash_value_matches_known_canonical_json_vector() {
        // `{"b":2,"a":1}` canonicalizes to compact `{"a":1,"b":2}`, whose
        // SHA-256 is the vector below (verified: shasum of `{"a":1,"b":2}`).
        assert_eq!(
            hash_value(&json!({ "b": 2, "a": 1 })).unwrap(),
            "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
        );
    }

    #[test]
    fn hash_value_matches_known_nested_canonical_vector() {
        // Recursive key sort + array-order preservation:
        // input canonicalizes to `{"alpha":[3,1,2],"nested":{"x":null,"y":true},"z":"end"}`.
        let value = json!({
            "z": "end",
            "nested": { "y": true, "x": null },
            "alpha": [3, 1, 2],
        });
        assert_eq!(
            hash_value(&value).unwrap(),
            "aeb5e2b1fc6fa76447a4cc659fa2e7be5ec651288bacbdb06b70037429ce36e0",
        );
    }

    #[test]
    fn hash_is_object_key_order_independent() {
        // Same key/value pairs in a different insertion order → same digest.
        assert_eq!(
            hash_value(&json!({ "a": 1, "b": 2 })).unwrap(),
            hash_value(&json!({ "b": 2, "a": 1 })).unwrap(),
        );
        // Different values → different digest.
        assert_ne!(
            hash_value(&json!({ "a": 1, "b": 2 })).unwrap(),
            hash_value(&json!({ "a": 2, "b": 1 })).unwrap(),
        );
    }

    #[test]
    fn hash_preserves_array_order() {
        assert_ne!(
            hash_value(&json!([1, 2, 3])).unwrap(),
            hash_value(&json!([3, 2, 1])).unwrap(),
        );
    }

    #[test]
    fn canonicalize_sorts_nested_keys_and_keeps_array_order() {
        let canonical = canonicalize(&json!({
            "b": [2, 1],
            "a": { "d": 1, "c": 2 },
        }));
        // Compact serialization exposes the resulting key/element order directly.
        assert_eq!(
            serde_json::to_string(&canonical).unwrap(),
            r#"{"a":{"c":2,"d":1},"b":[2,1]}"#,
        );
    }

    #[test]
    fn hash_canonical_json_agrees_with_hash_value() {
        let value = json!({ "beta": [1, 2], "alpha": "x" });
        assert_eq!(hash_canonical_json(&value), hash_value(&value).unwrap());
    }

    #[test]
    fn dedup_preserving_order_keeps_first_occurrence() {
        assert_eq!(
            dedup_preserving_order(vec!["a", "b", "a", "c", "b", "d"]),
            vec!["a", "b", "c", "d"],
        );
        // Numeric ids: first-seen order is preserved, later dups dropped.
        assert_eq!(dedup_preserving_order(vec![3, 1, 3, 2, 1]), vec![3, 1, 2]);
        let empty: Vec<i32> = Vec::new();
        assert_eq!(dedup_preserving_order(empty), Vec::<i32>::new());
    }
}
