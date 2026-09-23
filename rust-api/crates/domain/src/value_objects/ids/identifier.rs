use crate::error::DomainError;
use crate::value_objects::ids::entity_marker::EntityMarker;
use core::marker::PhantomData;
use uuid::Uuid;

pub struct Id<Entity>
where
    Entity: EntityMarker,
{
    value: Uuid,
    marker: PhantomData<Entity>,
}

impl<Entity> Id<Entity>
where
    Entity: EntityMarker,
{
    pub fn from_uuid(value: Uuid) -> Self {
        Self {
            value,
            marker: PhantomData,
        }
    }

    pub fn parse(raw: &str) -> Result<Self, DomainError> {
        match Uuid::parse_str(raw) {
            Ok(parsed) => Ok(Self::from_uuid(parsed)),
            Err(cause) => Err(DomainError::IdentifierMalformed {
                reason: cause.to_string(),
            }),
        }
    }

    pub fn as_uuid(&self) -> &Uuid {
        &self.value
    }

    pub fn into_uuid(self) -> Uuid {
        self.value
    }

    pub fn entity_name(&self) -> &'static str {
        Entity::ENTITY_NAME
    }
}

impl<Entity> Clone for Id<Entity>
where
    Entity: EntityMarker,
{
    fn clone(&self) -> Self {
        *self
    }
}

impl<Entity> Copy for Id<Entity> where Entity: EntityMarker {}

impl<Entity> PartialEq for Id<Entity>
where
    Entity: EntityMarker,
{
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<Entity> Eq for Id<Entity> where Entity: EntityMarker {}

impl<Entity> core::hash::Hash for Id<Entity>
where
    Entity: EntityMarker,
{
    fn hash<H>(&self, state: &mut H)
    where
        H: core::hash::Hasher,
    {
        self.value.hash(state);
    }
}

impl<Entity> core::fmt::Debug for Id<Entity>
where
    Entity: EntityMarker,
{
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Id")
            .field("entity", &Entity::ENTITY_NAME)
            .field("value", &self.value)
            .finish()
    }
}

impl<Entity> core::fmt::Display for Id<Entity>
where
    Entity: EntityMarker,
{
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "{}:{}", Entity::ENTITY_NAME, self.value)
    }
}

impl<Entity> serde::Serialize for Id<Entity>
where
    Entity: EntityMarker,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.value.serialize(serializer)
    }
}

impl<'de, Entity> serde::Deserialize<'de> for Id<Entity>
where
    Entity: EntityMarker,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let parsed = Uuid::deserialize(deserializer)?;
        Ok(Self::from_uuid(parsed))
    }
}
