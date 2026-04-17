// File: server/src/auth/slug.rs
// Purpose: Slug validation + reserved-word list (teacher-chosen room slugs).
// Role: Input sanitiser used by signup; also by SlugKey for in-memory routing.
// Exports: validate, suggest_alternatives, RESERVED_SLUGS
// Depends: regex, once_cell
// Invariants: pure fn — no IO; regex ^[a-z][a-z0-9-]{1,30}[a-z0-9]$; reserved list
//             never contains strings the regex would reject.
// Last updated: Sprint 1 (2026-04-17) -- initial implementation

use once_cell::sync::Lazy;
use regex::Regex;

use crate::error::AppError;

pub const RESERVED_SLUGS: &[&str] = &[
    "admin", "api", "assets", "auth", "dev", "health", "login", "logout",
    "signup", "static", "teach", "ws",
];

static SLUG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z][a-z0-9-]{1,30}[a-z0-9]$").expect("static regex"));

pub fn validate(raw: &str) -> Result<String, AppError> {
    let lower = raw.trim().to_ascii_lowercase();
    if !SLUG_RE.is_match(&lower) {
        return Err(AppError::BadRequest(
            "slug must be 3–32 chars, lowercase, start with a letter, end with a letter or digit, and use only letters, digits, and hyphens".into(),
        ));
    }
    if RESERVED_SLUGS.iter().any(|r| *r == lower.as_str()) {
        return Err(AppError::BadRequest(
            format!("slug '{lower}' is reserved").into(),
        ));
    }
    Ok(lower)
}

/// Produce up to 8 alternative slug suggestions when the requested slug is
/// taken. Returns names that pass `validate`; the caller must still check
/// availability against the DB.
pub fn suggest_alternatives(base: &str) -> Vec<String> {
    let mut out = Vec::new();
    for n in 2..=9 {
        let candidate = format!("{base}-{n}");
        if validate(&candidate).is_ok() {
            out.push(candidate);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_basic_slugs() {
        assert_eq!(validate("alice").unwrap(), "alice");
        assert_eq!(validate("Alice").unwrap(), "alice");
        assert_eq!(validate("alice-b").unwrap(), "alice-b");
        assert_eq!(validate("a1b").unwrap(), "a1b");
    }

    #[test]
    fn rejects_short_slugs() {
        assert!(validate("ab").is_err());
        assert!(validate("a").is_err());
    }

    #[test]
    fn rejects_reserved() {
        for r in RESERVED_SLUGS {
            assert!(validate(r).is_err(), "reserved: {r}");
        }
    }

    #[test]
    fn rejects_leading_digit_or_hyphen() {
        assert!(validate("1abc").is_err());
        assert!(validate("-abc").is_err());
    }

    #[test]
    fn rejects_trailing_hyphen() {
        assert!(validate("abc-").is_err());
    }

    #[test]
    fn rejects_bad_chars() {
        assert!(validate("ab c").is_err());
        assert!(validate("ab_c").is_err());
        assert!(validate("ab.c").is_err());
        assert!(validate("ab/c").is_err());
    }

    #[test]
    fn rejects_too_long() {
        let s = "a".repeat(33);
        assert!(validate(&s).is_err());
    }

    #[test]
    fn suggests_numbered_alternatives() {
        let s = suggest_alternatives("alice");
        assert!(s.contains(&"alice-2".to_string()));
        assert!(s.contains(&"alice-9".to_string()));
        assert_eq!(s.len(), 8);
    }

    #[test]
    fn property_validation_agrees_with_regex_and_reserved() {
        use proptest::prelude::*;

        proptest!(|(raw in "[ -~]{0,40}")| {
            let result = validate(&raw);
            let lower = raw.trim().to_ascii_lowercase();
            let matches_re = SLUG_RE.is_match(&lower);
            let reserved = RESERVED_SLUGS.iter().any(|r| *r == lower.as_str());
            let should_pass = matches_re && !reserved;
            prop_assert_eq!(result.is_ok(), should_pass);
        });
    }
}
