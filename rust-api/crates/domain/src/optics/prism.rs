use std::sync::Arc;

type BoxedPreview<Source, Focus> = Box<dyn Fn(&Source) -> Option<Focus> + Send + Sync>;
type BoxedReview<Source, Focus> = Box<dyn Fn(Focus) -> Source + Send + Sync>;

pub struct Prism<Source, Focus> {
    partial_preview: BoxedPreview<Source, Focus>,
    total_review: BoxedReview<Source, Focus>,
}

impl<Source, Focus> Prism<Source, Focus>
where
    Source: 'static,
    Focus: 'static,
{
    pub fn new<PreviewFn, ReviewFn>(preview: PreviewFn, review: ReviewFn) -> Self
    where
        PreviewFn: Fn(&Source) -> Option<Focus> + Send + Sync + 'static,
        ReviewFn: Fn(Focus) -> Source + Send + Sync + 'static,
    {
        Self {
            partial_preview: Box::new(preview),
            total_review: Box::new(review),
        }
    }

    pub fn preview(&self, source: &Source) -> Option<Focus> {
        (self.partial_preview)(source)
    }

    pub fn review(&self, focus: Focus) -> Source {
        (self.total_review)(focus)
    }

    pub fn matches(&self, source: &Source) -> bool {
        self.preview(source).is_some()
    }

    pub fn compose<DeeperFocus>(
        self,
        deeper: Prism<Focus, DeeperFocus>,
    ) -> Prism<Source, DeeperFocus>
    where
        DeeperFocus: 'static,
    {
        let shared_outer_prism: Arc<Prism<Source, Focus>> = Arc::new(self);
        let shared_inner_prism: Arc<Prism<Focus, DeeperFocus>> = Arc::new(deeper);

        let outer_prism_for_preview = Arc::clone(&shared_outer_prism);
        let inner_prism_for_preview = Arc::clone(&shared_inner_prism);
        let outer_prism_for_review = Arc::clone(&shared_outer_prism);
        let inner_prism_for_review = Arc::clone(&shared_inner_prism);

        Prism::new(
            move |source: &Source| -> Option<DeeperFocus> {
                match outer_prism_for_preview.preview(source) {
                    Some(intermediate_value) => {
                        inner_prism_for_preview.preview(&intermediate_value)
                    }
                    None => None,
                }
            },
            move |deeper_focus: DeeperFocus| -> Source {
                let intermediate_value = inner_prism_for_review.review(deeper_focus);
                outer_prism_for_review.review(intermediate_value)
            },
        )
    }
}
