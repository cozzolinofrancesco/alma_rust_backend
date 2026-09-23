use crate::error::DomainError;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Email {
    normalized_representation: String,
}

impl Email {
    pub fn parse(raw_candidate: String) -> Result<Self, DomainError> {
        let trimmed_candidate = raw_candidate.trim();
        if trimmed_candidate.is_empty() {
            return Err(DomainError::EmailMalformed {
                reason: String::from("value was empty after trimming"),
            });
        }
        let count_of_at_symbols = trimmed_candidate.matches('@').count();
        if count_of_at_symbols != 1 {
            return Err(DomainError::EmailMalformed {
                reason: format!(
                    "expected exactly one '@' separator but found {count_of_at_symbols}"
                ),
            });
        }
        let (local_part, domain_part) = trimmed_candidate
            .split_once('@')
            .expect("presence of exactly one separator was verified above");
        if local_part.is_empty() {
            return Err(DomainError::EmailMalformed {
                reason: String::from("local part preceding '@' was empty"),
            });
        }
        if domain_part.is_empty() {
            return Err(DomainError::EmailMalformed {
                reason: String::from("domain part following '@' was empty"),
            });
        }
        if !domain_part.contains('.') {
            return Err(DomainError::EmailMalformed {
                reason: String::from("domain part did not contain a '.' label separator"),
            });
        }
        Ok(Self {
            normalized_representation: trimmed_candidate.to_ascii_lowercase(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.normalized_representation
    }

    pub fn into_string(self) -> String {
        self.normalized_representation
    }
}

impl core::fmt::Display for Email {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.normalized_representation)
    }
}

impl serde::Serialize for Email {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.normalized_representation)
    }
}

impl<'de> serde::Deserialize<'de> for Email {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw_candidate = String::deserialize(deserializer)?;
        Email::parse(raw_candidate).map_err(serde::de::Error::custom)
    }
}
