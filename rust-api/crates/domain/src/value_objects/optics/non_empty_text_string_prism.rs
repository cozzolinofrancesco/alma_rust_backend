use crate::optics::Prism;
use crate::value_objects::non_empty_text::NonEmptyText;

pub fn non_empty_text_string_prism() -> Prism<String, NonEmptyText> {
    Prism::new(
        |candidate_representation: &String| {
            NonEmptyText::parse(candidate_representation.clone()).ok()
        },
        |validated_non_empty_text: NonEmptyText| validated_non_empty_text.into_string(),
    )
}
