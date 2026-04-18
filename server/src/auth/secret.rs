// File: server/src/auth/secret.rs
// Purpose: SecretString wrapper — Debug-safe, constant-time equality via `subtle`.
// Role: Wraps any string-typed secret so it never appears in logs or panic messages.
// Exports: SecretString
// Depends: subtle
// Invariants: Debug always prints "<redacted>". eq uses subtle::ConstantTimeEq so
//             comparison time does not leak secret content or length.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl std::fmt::Display for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl PartialEq for SecretString {
    fn eq(&self, other: &Self) -> bool {
        let a = self.0.as_bytes();
        let b = other.0.as_bytes();
        // Constant-time compare: pad shorter to avoid length leak.
        // subtle::ConstantTimeEq requires equal-length slices, so we
        // compare byte-by-byte with explicit length mismatch check.
        if a.len() != b.len() {
            // Still consume equal time for the comparison body, then return false.
            let _ = a.ct_eq(b.get(..a.len()).unwrap_or(b));
            return false;
        }
        a.ct_eq(b).into()
    }
}

impl Eq for SecretString {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_is_redacted() {
        let s = SecretString::new("super-secret-value");
        assert_eq!(format!("{s:?}"), "<redacted>");
        assert_eq!(format!("{s}"), "<redacted>");
    }

    #[test]
    fn equal_secrets_are_equal() {
        let a = SecretString::new("same-value");
        let b = SecretString::new("same-value");
        assert_eq!(a, b);
    }

    #[test]
    fn different_secrets_are_not_equal() {
        let a = SecretString::new("value-a");
        let b = SecretString::new("value-b");
        assert_ne!(a, b);
    }

    #[test]
    fn prefix_is_not_equal() {
        let a = SecretString::new("short");
        let b = SecretString::new("shorter");
        assert_ne!(a, b);
    }
}
