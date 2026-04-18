// File: server/src/auth/secret.rs
// Purpose: SecretString wrapper — Debug-safe, constant-time equality via `subtle`.
// Role: Wraps any string-typed secret so it never appears in logs or panic messages.
// Exports: SecretString
// Depends: subtle, hmac, sha2
// Invariants: Debug always prints "<redacted>". eq is always constant-time regardless
//             of input length — both operands are HMAC-SHA256 digested with a fixed
//             key before comparison, so the output is always 32 bytes and
//             subtle::ConstantTimeEq can apply.
// Last updated: Sprint 5 (2026-04-18) -- R1 fix: true CT on length mismatch

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

// Fixed key — not a secret; sole purpose is producing equal-length digests.
const DIGEST_KEY: &[u8; 1] = &[0u8];

fn ct_digest(s: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(DIGEST_KEY).expect("HMAC accepts any key");
    mac.update(s);
    mac.finalize().into_bytes().into()
}

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
        // HMAC-SHA256 both inputs with a fixed key so we always compare
        // 32-byte digests — constant-time regardless of input length.
        ct_digest(self.0.as_bytes())
            .ct_eq(&ct_digest(other.0.as_bytes()))
            .into()
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

    #[test]
    fn empty_vs_nonempty_is_not_equal() {
        let a = SecretString::new("");
        let b = SecretString::new("nonempty");
        assert_ne!(a, b);
    }
}
