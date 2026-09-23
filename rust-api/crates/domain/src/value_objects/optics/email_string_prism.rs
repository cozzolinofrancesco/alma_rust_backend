use crate::optics::Prism;
use crate::value_objects::email::Email;

pub fn email_string_prism() -> Prism<String, Email> {
    Prism::new(
        |candidate_representation: &String| Email::parse(candidate_representation.clone()).ok(),
        |validated_email: Email| validated_email.into_string(),
    )
}
