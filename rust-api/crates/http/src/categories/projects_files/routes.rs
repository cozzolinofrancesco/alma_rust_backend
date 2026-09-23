use crate::categories::projects_files::handlers::*;
use crate::state::ApplicationState;
use alma_application::ports::unit_of_work::UnitOfWork;
use axum::Router;
use axum::routing::{get, post};

pub fn build_projects_files_router<TransactionalUnitOfWork>()
-> Router<ApplicationState<TransactionalUnitOfWork>>
where
    TransactionalUnitOfWork: UnitOfWork + 'static,
{
    Router::new()
        .route(
            "/api/create-project",
            post(create_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/list-projects",
            get(list_projects_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/list-saved-projects",
            get(list_saved_projects_handler::<TransactionalUnitOfWork>)
                .delete(delete_saved_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/load-project",
            get(load_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/save-project",
            post(save_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/canvas/save-project",
            post(canvas_save_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/load-ai3d-project",
            get(load_ai3d_project_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/create-subfolder",
            post(create_subfolder_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/validate-folder",
            post(validate_folder_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/debug-shared-projects",
            get(debug_shared_projects_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/download-pdf",
            post(download_pdf_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/files-search",
            get(files_search_by_query_handler::<TransactionalUnitOfWork>)
                .post(files_search_by_body_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier/files/:file_identifier",
            get(fetch_project_file_handler::<TransactionalUnitOfWork>)
                .post(store_project_file_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier/folders/:folder_name/files",
            get(list_folder_files_handler::<TransactionalUnitOfWork>)
                .post(create_folder_file_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier/folders/:folder_name/files/:file_identifier",
            get(fetch_folder_file_handler::<TransactionalUnitOfWork>)
                .put(replace_folder_file_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier/folders/:folder_name/files/:file_identifier/download",
            get(download_folder_file_handler::<TransactionalUnitOfWork>),
        )
        .route(
            "/api/projects/:project_identifier/folders/folder_id/:folder_identifier/contents",
            get(list_folder_contents_handler::<TransactionalUnitOfWork>),
        )
}
