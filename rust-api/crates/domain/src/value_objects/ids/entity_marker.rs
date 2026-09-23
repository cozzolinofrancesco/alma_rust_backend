pub trait EntityMarker: Copy + Clone + Send + Sync + 'static {
    const ENTITY_NAME: &'static str;
}
