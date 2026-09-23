use crate::error::DomainError;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NonEmptyText {
    preserved_value: String,
}

impl NonEmptyText {
    pub fn parse(raw_candidate: String) -> Result<Self, DomainError> {
        if raw_candidate.trim().is_empty() {
            return Err(DomainError::NonEmptyTextEmpty);
        }
        Ok(Self {
            preserved_value: raw_candidate,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.preserved_value
    }

    pub fn into_string(self) -> String {
        self.preserved_value
    }
}

impl core::fmt::Display for NonEmptyText {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.preserved_value)
    }
}

impl serde::Serialize for NonEmptyText {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.preserved_value)
    }
}

impl<'de> serde::Deserialize<'de> for NonEmptyText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw_candidate = String::deserialize(deserializer)?;
        NonEmptyText::parse(raw_candidate).map_err(serde::de::Error::custom)
    }
}
