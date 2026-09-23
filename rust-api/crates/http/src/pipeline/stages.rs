#[derive(Debug, Clone, Copy)]
pub enum RequestHasNotYetBeenValidated {}

#[derive(Debug, Clone, Copy)]
pub enum RequestHasBeenValidated {}

#[derive(Debug, Clone, Copy)]
pub enum RequestHasBeenAuthenticated {}

#[derive(Debug, Clone, Copy)]
pub enum RequestHasBeenAuthorized {}
