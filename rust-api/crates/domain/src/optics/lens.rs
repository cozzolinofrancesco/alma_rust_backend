use std::sync::Arc;

type BoxedGetter<Source, Focus> = Box<dyn Fn(&Source) -> Focus + Send + Sync>;
type BoxedSetter<Source, Focus> = Box<dyn Fn(Source, Focus) -> Source + Send + Sync>;

pub struct Lens<Source, Focus> {
    focused_getter: BoxedGetter<Source, Focus>,
    focused_setter: BoxedSetter<Source, Focus>,
}

impl<Source, Focus> Lens<Source, Focus>
where
    Source: 'static,
    Focus: 'static,
{
    pub fn new<GetterFn, SetterFn>(getter: GetterFn, setter: SetterFn) -> Self
    where
        GetterFn: Fn(&Source) -> Focus + Send + Sync + 'static,
        SetterFn: Fn(Source, Focus) -> Source + Send + Sync + 'static,
    {
        Self {
            focused_getter: Box::new(getter),
            focused_setter: Box::new(setter),
        }
    }

    pub fn get(&self, source: &Source) -> Focus {
        (self.focused_getter)(source)
    }

    pub fn set(&self, source: Source, replacement: Focus) -> Source {
        (self.focused_setter)(source, replacement)
    }

    pub fn modify<Transformation>(&self, source: Source, transformation: Transformation) -> Source
    where
        Transformation: FnOnce(Focus) -> Focus,
    {
        let previously_focused_value = self.get(&source);
        let transformed_value = transformation(previously_focused_value);
        self.set(source, transformed_value)
    }

    pub fn compose<DeeperFocus>(self, deeper: Lens<Focus, DeeperFocus>) -> Lens<Source, DeeperFocus>
    where
        DeeperFocus: 'static,
    {
        let shared_outer_lens: Arc<Lens<Source, Focus>> = Arc::new(self);
        let shared_inner_lens: Arc<Lens<Focus, DeeperFocus>> = Arc::new(deeper);

        let outer_lens_for_getter = Arc::clone(&shared_outer_lens);
        let inner_lens_for_getter = Arc::clone(&shared_inner_lens);
        let outer_lens_for_setter = Arc::clone(&shared_outer_lens);
        let inner_lens_for_setter = Arc::clone(&shared_inner_lens);

        Lens::new(
            move |source: &Source| -> DeeperFocus {
                let intermediate_value = outer_lens_for_getter.get(source);
                inner_lens_for_getter.get(&intermediate_value)
            },
            move |source: Source, replacement: DeeperFocus| -> Source {
                let intermediate_value = outer_lens_for_setter.get(&source);
                let rebuilt_intermediate =
                    inner_lens_for_setter.set(intermediate_value, replacement);
                outer_lens_for_setter.set(source, rebuilt_intermediate)
            },
        )
    }
}
