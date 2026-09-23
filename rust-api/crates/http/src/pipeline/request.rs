use crate::error::HttpError;
use crate::pipeline::stages::{
    RequestHasBeenAuthenticated, RequestHasBeenAuthorized, RequestHasBeenValidated,
    RequestHasNotYetBeenValidated,
};
use alma_domain::value_objects::Email;
use core::marker::PhantomData;

pub struct HttpRequestInPipeline<PipelineStage> {
    correlation_identifier: String,
    declared_principal: Option<Email>,
    _pipeline_stage_marker: PhantomData<PipelineStage>,
}

impl HttpRequestInPipeline<RequestHasNotYetBeenValidated> {
    pub fn originate(correlation_identifier: String) -> Self {
        Self {
            correlation_identifier,
            declared_principal: None,
            _pipeline_stage_marker: PhantomData,
        }
    }

    pub fn validate(self) -> Result<HttpRequestInPipeline<RequestHasBeenValidated>, HttpError> {
        if self.correlation_identifier.trim().is_empty() {
            return Err(HttpError::RequestBodyWasMalformed {
                explanation: String::from("the correlation identifier was empty"),
            });
        }
        Ok(HttpRequestInPipeline {
            correlation_identifier: self.correlation_identifier,
            declared_principal: self.declared_principal,
            _pipeline_stage_marker: PhantomData,
        })
    }
}

impl HttpRequestInPipeline<RequestHasBeenValidated> {
    pub fn authenticate(
        self,
        authenticated_principal: Email,
    ) -> Result<HttpRequestInPipeline<RequestHasBeenAuthenticated>, HttpError> {
        Ok(HttpRequestInPipeline {
            correlation_identifier: self.correlation_identifier,
            declared_principal: Some(authenticated_principal),
            _pipeline_stage_marker: PhantomData,
        })
    }
}

impl HttpRequestInPipeline<RequestHasBeenAuthenticated> {
    pub fn authorize(self) -> Result<HttpRequestInPipeline<RequestHasBeenAuthorized>, HttpError> {
        match self.declared_principal {
            Some(_) => Ok(HttpRequestInPipeline {
                correlation_identifier: self.correlation_identifier,
                declared_principal: self.declared_principal,
                _pipeline_stage_marker: PhantomData,
            }),
            None => Err(HttpError::AuthorizationWasDenied {
                explanation: String::from(
                    "no authenticated principal was present at the authorization stage",
                ),
            }),
        }
    }
}

impl HttpRequestInPipeline<RequestHasBeenAuthorized> {
    pub fn correlation_identifier(&self) -> &str {
        &self.correlation_identifier
    }

    pub fn authorized_principal(&self) -> &Email {
        self.declared_principal
            .as_ref()
            .expect("an authorized request always carries a principal")
    }
}
