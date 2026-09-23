use crate::optics::Prism;
use crate::value_objects::project_name::ProjectName;

pub fn project_name_string_prism() -> Prism<String, ProjectName> {
    Prism::new(
        |candidate_representation: &String| {
            ProjectName::parse(candidate_representation.clone()).ok()
        },
        |validated_project_name: ProjectName| validated_project_name.into_string(),
    )
}
