use super::lens::Lens;
use super::prism::Prism;
use std::sync::Arc;

pub fn compose_lenses<Source, Intermediate, Focus>(
    outer: Lens<Source, Intermediate>,
    inner: Lens<Intermediate, Focus>,
) -> Lens<Source, Focus>
where
    Source: 'static,
    Intermediate: 'static,
    Focus: 'static,
{
    outer.compose(inner)
}

pub fn compose_prisms<Source, Intermediate, Focus>(
    outer: Prism<Source, Intermediate>,
    inner: Prism<Intermediate, Focus>,
) -> Prism<Source, Focus>
where
    Source: 'static,
    Intermediate: 'static,
    Focus: 'static,
{
    outer.compose(inner)
}

pub struct OptionalAccess<Source, Focus> {
    optional_preview: Box<dyn Fn(&Source) -> Option<Focus> + Send + Sync>,
    optional_reconstruct: Box<dyn Fn(Source, Focus) -> Source + Send + Sync>,
}

impl<Source, Focus> OptionalAccess<Source, Focus>
where
    Source: 'static,
    Focus: 'static,
{
    pub fn from_lens_then_prism<Through>(
        lens: Lens<Source, Through>,
        prism: Prism<Through, Focus>,
    ) -> Self
    where
        Through: 'static,
    {
        let shared_lens = Arc::new(lens);
        let shared_prism = Arc::new(prism);

        let lens_for_preview = Arc::clone(&shared_lens);
        let prism_for_preview = Arc::clone(&shared_prism);
        let lens_for_reconstruct = Arc::clone(&shared_lens);
        let prism_for_reconstruct = Arc::clone(&shared_prism);

        Self {
            optional_preview: Box::new(move |source: &Source| -> Option<Focus> {
                let intermediate_value = lens_for_preview.get(source);
                prism_for_preview.preview(&intermediate_value)
            }),
            optional_reconstruct: Box::new(move |source: Source, focus: Focus| -> Source {
                let rebuilt_intermediate = prism_for_reconstruct.review(focus);
                lens_for_reconstruct.set(source, rebuilt_intermediate)
            }),
        }
    }

    pub fn preview(&self, source: &Source) -> Option<Focus> {
        (self.optional_preview)(source)
    }

    pub fn set(&self, source: Source, focus: Focus) -> Source {
        (self.optional_reconstruct)(source, focus)
    }
}
