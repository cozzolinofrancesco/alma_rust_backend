use crate::error::DomainError;

pub const PROJECT_NAME_MAXIMUM_LENGTH: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProjectName {
    canonical_value: String,
}

impl ProjectName {
    pub fn parse(raw_candidate: String) -> Result<Self, DomainError> {
        let trimmed_candidate = raw_candidate.trim();
        if trimmed_candidate.is_empty() {
            return Err(DomainError::ProjectNameEmpty);
        }
        if trimmed_candidate.chars().count() > PROJECT_NAME_MAXIMUM_LENGTH {
            return Err(DomainError::ProjectNameTooLong {
                maximum: PROJECT_NAME_MAXIMUM_LENGTH,
            });
        }
        Ok(Self {
            canonical_value: trimmed_candidate.to_string(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.canonical_value
    }

    pub fn into_string(self) -> String {
        self.canonical_value
    }
}

impl core::fmt::Display for ProjectName {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.canonical_value)
    }
}

impl serde::Serialize for ProjectName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.canonical_value)
    }
}

impl<'de> serde::Deserialize<'de> for ProjectName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw_candidate = String::deserialize(deserializer)?;
        ProjectName::parse(raw_candidate).map_err(serde::de::Error::custom)
    }
}
