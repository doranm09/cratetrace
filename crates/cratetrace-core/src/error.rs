use std::fmt;

#[derive(Debug)]
pub struct CratetraceError {
    message: String,
}

impl CratetraceError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for CratetraceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CratetraceError {}

impl From<std::io::Error> for CratetraceError {
    fn from(value: std::io::Error) -> Self {
        Self::new(value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, CratetraceError>;
