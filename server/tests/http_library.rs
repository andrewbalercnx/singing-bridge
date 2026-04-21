// File: server/tests/http_library.rs
// Purpose: Integration tests for the accompaniment library HTTP API.
// Role: Verify asset CRUD, ownership isolation, token lifecycle, magic-byte rejection,
//       and media endpoint semantics (404 on unknown/expired tokens, no oracle).
// Last updated: Sprint 12a (2026-04-21) -- WAV, 413, typed upload errors, wiremock tests

mod common;

use wiremock::{
    matchers::{method, path},
    Mock, MockServer, ResponseTemplate,
};

const PDF_HEADER: &[u8] = b"%PDF-1.4 test content";
const MIDI_HEADER: &[u8] = b"MThd\x00\x00\x00\x06\x00\x01\x00\x01\x01\xe0";
// Valid WAV: RIFF + 4-byte size + WAVE + padding to ensure body ≥ 12 bytes.
const WAV_HEADER: &[u8] = b"RIFF\x00\x00\x00\x00WAVE fake-wav-data";
// RIFF container but NOT WAV (bytes 8-11 are not "WAVE").
const RIFF_NON_WAV: &[u8] = b"RIFF\x00\x00\x00\x00AVI fake-avi-data";
const GARBAGE: &[u8] = b"\x00\x00\x00\x00 not a known format";
// Minimal valid empty ZIP (EOCD record only — 22 bytes, zero entries).
const EMPTY_ZIP: &[u8] = &[
    0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

// ---------------------------------------------------------------------------
// Library page
// ---------------------------------------------------------------------------

#[tokio::test]
async fn library_page_requires_auth() {
    let app = common::spawn_app().await;
    let r = app.client.get(app.url("/teach/room-a/library")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn library_page_returns_html() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .get(app.url("/teach/room-a/library"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let ct = r.headers().get("content-type").unwrap().to_str().unwrap();
    assert!(ct.contains("text/html"));
    assert_eq!(
        r.headers().get("cache-control").unwrap().to_str().unwrap(),
        "no-store",
    );
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Asset list / detail — auth
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_assets_requires_auth() {
    let app = common::spawn_app().await;
    let r = app.client
        .get(app.url("/teach/room-a/library/assets"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    app.shutdown().await;
}

#[tokio::test]
async fn list_assets_empty_on_new_teacher() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .get(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body, serde_json::json!([]));
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Upload — magic-byte validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_pdf_succeeds() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Test Score")
        .header("content-type", "application/pdf")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["title"], "Test Score");
    assert!(body["id"].as_i64().is_some());
    app.shutdown().await;
}

#[tokio::test]
async fn upload_midi_succeeds() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Piano MIDI")
        .header("content-type", "audio/midi")
        .body(MIDI_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    app.shutdown().await;
}

#[tokio::test]
async fn upload_garbage_rejected_422() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Junk")
        .body(GARBAGE.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "unsupported_file_type");
    app.shutdown().await;
}

#[tokio::test]
async fn upload_missing_title_rejected_400() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn upload_requires_auth() {
    let app = common::spawn_app().await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("x-title", "Test")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Cross-teacher ownership isolation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cross_teacher_cannot_see_other_assets() {
    let app = common::spawn_app().await;
    let (t_a, t_b) = common::make_two_teachers(&app).await;

    // Teacher A uploads an asset.
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={}", t_a.cookie))
        .header("x-title", "A's score")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let body: serde_json::Value = r.json().await.unwrap();
    let asset_id = body["id"].as_i64().unwrap();

    // Teacher B cannot see it via list.
    let list = app.client
        .get(app.url("/teach/room-b/library/assets"))
        .header("cookie", format!("sb_session={}", t_b.cookie))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(list, serde_json::json!([]));

    // Teacher B cannot get detail.
    let detail = app.client
        .get(app.url(&format!("/teach/room-b/library/assets/{asset_id}")))
        .header("cookie", format!("sb_session={}", t_b.cookie))
        .send()
        .await
        .unwrap();
    assert_eq!(detail.status(), 404);

    app.shutdown().await;
}

#[tokio::test]
async fn cross_teacher_cannot_delete_other_asset() {
    let app = common::spawn_app().await;
    let (t_a, t_b) = common::make_two_teachers(&app).await;

    // Teacher A uploads.
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={}", t_a.cookie))
        .header("x-title", "A's score")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = r.json().await.unwrap();
    let asset_id = body["id"].as_i64().unwrap();

    // Teacher B tries to delete via their own slug.
    let del = app.client
        .delete(app.url(&format!("/teach/room-b/library/assets/{asset_id}")))
        .header("cookie", format!("sb_session={}", t_b.cookie))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 404);

    // Asset still accessible to Teacher A.
    let r2 = app.client
        .get(app.url(&format!("/teach/room-a/library/assets/{asset_id}")))
        .header("cookie", format!("sb_session={}", t_a.cookie))
        .send()
        .await
        .unwrap();
    assert_eq!(r2.status(), 200);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Get asset detail — token issuance
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_asset_detail_returns_has_fields() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "My Score")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = r.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();

    let detail = app.client
        .get(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();

    assert_eq!(detail["id"], id);
    assert_eq!(detail["title"], "My Score");
    assert_eq!(detail["has_pdf"], true);
    assert_eq!(detail["has_midi"], false);
    assert!(detail["page_tokens"].is_array());
    assert!(detail["variants"].is_array());
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Delete asset — soft-delete + token invalidation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_asset_returns_204_and_hides_from_list() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;

    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "To Delete")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = r.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();

    let del = app.client
        .delete(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    // No longer in list.
    let list = app.client
        .get(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(list, serde_json::json!([]));

    // No longer accessible via detail.
    let detail = app.client
        .get(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(detail.status(), 404);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Media token endpoint — no oracle attack surface
// ---------------------------------------------------------------------------

#[tokio::test]
async fn media_unknown_token_returns_404() {
    let app = common::spawn_app().await;
    let r = app.client
        .get(app.url("/api/media/deadbeefdeadbeef"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    app.shutdown().await;
}

#[tokio::test]
async fn media_token_serves_blob_content() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;

    // Upload a PDF asset.
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Tokenised")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = r.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();

    // Manually insert a page PNG blob so we can get a token for it.
    let page_bytes = b"\x89PNG test page";
    let page_key = format!("{}.png", uuid::Uuid::new_v4());
    use std::pin::Pin;
    app.state
        .blob
        .put(&page_key, Box::pin(std::io::Cursor::new(page_bytes.to_vec())) as Pin<Box<dyn tokio::io::AsyncRead + Send>>)
        .await
        .unwrap();

    // Patch the DB row to set page_blob_keys_json.
    sqlx::query(
        "UPDATE accompaniments SET page_blob_keys_json = ? WHERE id = ?",
    )
    .bind(serde_json::to_string(&vec![&page_key]).unwrap())
    .bind(id)
    .execute(&app.state.db)
    .await
    .unwrap();

    // GET /assets/:id issues a token for the page.
    let detail = app.client
        .get(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let token = detail["page_tokens"][0].as_str().unwrap().to_string();

    // GET /api/media/:token serves the PNG.
    let media = app.client
        .get(app.url(&format!("/api/media/{token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(media.status(), 200);
    assert!(media
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("image/png"));
    let got = media.bytes().await.unwrap();
    assert_eq!(got.as_ref(), page_bytes);

    app.shutdown().await;
}

#[tokio::test]
async fn media_token_invalidated_after_asset_delete() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;

    // Upload asset.
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "To Delete")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = r.json().await.unwrap();
    let id = body["id"].as_i64().unwrap();

    // Insert a page blob and link it.
    let page_bytes = b"\x89PNG page data";
    let page_key = format!("{}.png", uuid::Uuid::new_v4());
    use std::pin::Pin;
    app.state
        .blob
        .put(&page_key, Box::pin(std::io::Cursor::new(page_bytes.to_vec())) as Pin<Box<dyn tokio::io::AsyncRead + Send>>)
        .await
        .unwrap();
    sqlx::query("UPDATE accompaniments SET page_blob_keys_json = ? WHERE id = ?")
        .bind(serde_json::to_string(&vec![&page_key]).unwrap())
        .bind(id)
        .execute(&app.state.db)
        .await
        .unwrap();

    // Obtain a token.
    let detail = app.client
        .get(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let token = detail["page_tokens"][0].as_str().unwrap().to_string();

    // Delete the asset.
    let del = app.client
        .delete(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(del.status(), 204);

    // Token is now dead — 404, indistinguishable from unknown token.
    let media = app.client
        .get(app.url(&format!("/api/media/{token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(media.status(), 404);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Sidecar proxy — wiremock-backed happy path for /parts endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_parts_proxies_to_sidecar() {
    let mock_server = MockServer::start().await;

    // OMR endpoint returns a stub musicxml.
    let omr_body = serde_json::json!({
        "musicxml": base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"<score-partwise></score-partwise>",
        ),
        "page_count": 1u32,
    });
    Mock::given(method("POST"))
        .and(path("/omr"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&omr_body))
        .mount(&mock_server)
        .await;

    // list-parts returns two parts.
    let parts_body = serde_json::json!([
        { "index": 0, "name": "Piano", "instrument": "Piano", "has_notes": true },
        { "index": 1, "name": "Violin", "instrument": "Violin", "has_notes": true },
    ]);
    Mock::given(method("POST"))
        .and(path("/list-parts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&parts_body))
        .mount(&mock_server)
        .await;

    // Spawn app pointed at the mock sidecar.
    let opts = common::TestOpts {
        sidecar_url: Some(mock_server.uri().parse().unwrap()),
        ..Default::default()
    };
    let app = common::spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;

    // Upload a PDF.
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Bach")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let id = r.json::<serde_json::Value>().await.unwrap()["id"].as_i64().unwrap();

    // POST /parts.
    let parts = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/parts")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(parts.status(), 200);
    let body: serde_json::Value = parts.json().await.unwrap();
    assert_eq!(body.as_array().unwrap().len(), 2);
    assert_eq!(body[0]["name"], "Piano");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 18 — MIDI upload response includes kind field; no variant auto-created
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_midi_returns_kind_field_and_no_variant() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Piano MIDI")
        .header("content-type", "audio/midi")
        .body(MIDI_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["kind"], "midi");
    let id = body["id"].as_i64().unwrap();

    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM accompaniment_variants WHERE accompaniment_id = ?",
    )
    .bind(id)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(count, 0);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 19 — WAV upload: 201, kind=wav, variant created, blob bytes match
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_wav_creates_variant_and_stores_bytes() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Orchestra WAV")
        .header("content-type", "audio/wav")
        .body(WAV_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["kind"], "wav");
    let id = body["id"].as_i64().unwrap();
    let variant_id = body["variant_id"].as_i64().expect("variant_id present for WAV");

    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM accompaniment_variants WHERE accompaniment_id = ? AND id = ?",
    )
    .bind(id)
    .bind(variant_id)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(count, 1);

    // Serving via media token returns the original bytes.
    let detail = app.client
        .get(app.url(&format!("/teach/room-a/library/assets/{id}")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    let token = detail["variants"][0]["token"].as_str().unwrap().to_string();
    let media = app.client
        .get(app.url(&format!("/api/media/{token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(media.status(), 200);
    assert_eq!(media.bytes().await.unwrap().as_ref(), WAV_HEADER);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 20 — RIFF + non-WAVE → 422 unsupported_file_type
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_riff_non_wav_rejected_422() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "AVI")
        .body(RIFF_NON_WAV.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "unsupported_file_type");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 21 — Body < 12 bytes → 422 unsupported_file_type
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_short_body_rejected_422() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Short")
        .body(b"\x00\x01\x02".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "unsupported_file_type");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Tests 22–24e — Content-Type mismatch cases → 422 content_type_mismatch
// ---------------------------------------------------------------------------

async fn assert_content_type_mismatch(body_bytes: &[u8], declared_ct: &str) {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Mismatch")
        .header("content-type", declared_ct.to_string())
        .body(body_bytes.to_vec())
        .send()
        .await
        .unwrap();
    let status = r.status().as_u16();
    let b: serde_json::Value = r.json().await.unwrap();
    assert_eq!(status, 422, "expected 422 for ct={declared_ct}, got {status}, code={}", b["code"]);
    assert_eq!(b["code"], "content_type_mismatch", "ct={declared_ct}");
    app.shutdown().await;
}

#[tokio::test]
async fn ct_pdf_with_midi_bytes_rejected() {
    assert_content_type_mismatch(MIDI_HEADER, "application/pdf").await;
}

#[tokio::test]
async fn ct_midi_with_pdf_bytes_rejected() {
    assert_content_type_mismatch(PDF_HEADER, "audio/midi").await;
}

#[tokio::test]
async fn ct_wav_with_pdf_bytes_rejected() {
    assert_content_type_mismatch(PDF_HEADER, "audio/wav").await;
}

#[tokio::test]
async fn ct_wav_with_midi_bytes_rejected() {
    assert_content_type_mismatch(MIDI_HEADER, "audio/wav").await;
}

#[tokio::test]
async fn ct_pdf_with_wav_bytes_rejected() {
    assert_content_type_mismatch(WAV_HEADER, "application/pdf").await;
}

#[tokio::test]
async fn ct_midi_with_wav_bytes_rejected() {
    assert_content_type_mismatch(WAV_HEADER, "audio/midi").await;
}

#[tokio::test]
async fn ct_pdf_with_params_and_midi_bytes_rejected() {
    assert_content_type_mismatch(MIDI_HEADER, "application/pdf; charset=utf-8").await;
}

// ---------------------------------------------------------------------------
// Test 25 — Null magic bytes → 422 unsupported_file_type
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_null_magic_rejected_422() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Unknown")
        .body(vec![0u8; 20])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "unsupported_file_type");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 26 — Content-Length > 50 MB → 413 payload_too_large
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_content_length_over_limit_413() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let over_limit: u64 = 50 * 1024 * 1024 + 1;
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Big")
        .header("content-length", over_limit.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 413);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "payload_too_large");
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 27 — title > 255 bytes → 400
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_title_too_long_rejected_400() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let long_title = "a".repeat(256);
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", &long_title)
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 28 — label > 255 bytes in POST /variants → 400
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_variant_label_too_long_rejected_400() {
    let mock_server = MockServer::start().await;
    mount_omr_stub(&mock_server).await;
    mount_extract_midi_stub(&mock_server).await;
    mount_bar_timings_stub(&mock_server).await;
    mount_synthesise_stub(&mock_server).await;

    let opts = common::TestOpts {
        sidecar_url: Some(mock_server.uri().parse().unwrap()),
        ..Default::default()
    };
    let app = common::spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_pdf_with_app(&app, &cookie).await;

    // POST /midi to give the asset a MIDI blob.
    let midi_r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/midi")))
        .header("cookie", format!("sb_session={cookie}"))
        .json(&serde_json::json!({ "part_indices": [0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(midi_r.status(), 200, "midi setup failed");

    let long_label = "b".repeat(256);
    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/variants")))
        .header("cookie", format!("sb_session={cookie}"))
        .json(&serde_json::json!({
            "label": long_label,
            "tempo_pct": 100,
            "transpose_semitones": 0,
            "respect_repeats": false,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 29 — bar-timings > 100 KB → POST /midi → 400 (size limit)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_midi_bar_timings_too_large_rejected() {
    let mock_server = MockServer::start().await;
    mount_omr_stub(&mock_server).await;
    mount_extract_midi_stub(&mock_server).await;

    let timings: Vec<serde_json::Value> = (0i32..5000)
        .map(|i| serde_json::json!({"bar": i, "time_s": i as f64 * 0.5}))
        .collect();
    Mock::given(method("POST"))
        .and(path("/bar-timings"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_json(serde_json::json!({ "timings": timings })))
        .mount(&mock_server)
        .await;

    let opts = common::TestOpts {
        sidecar_url: Some(mock_server.uri().parse().unwrap()),
        ..Default::default()
    };
    let app = common::spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_pdf_with_app(&app, &cookie).await;

    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/midi")))
        .header("cookie", format!("sb_session={cookie}"))
        .json(&serde_json::json!({ "part_indices": [0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    // MIDI blob must not have been persisted.
    let row: (Option<String>,) = sqlx::query_as(
        "SELECT midi_blob_key FROM accompaniments WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!(row.0.is_none());

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 30 — bar-coords > 512 KB → POST /rasterise → 400 (size limit)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_rasterise_bar_coords_too_large_rejected() {
    let mock_server = MockServer::start().await;

    let coords: Vec<serde_json::Value> = (0i32..8000)
        .map(|i| serde_json::json!({
            "bar": i, "page": 0,
            "x_frac": 0.1, "y_frac": 0.1,
            "w_frac": 0.1, "h_frac": 0.1,
        }))
        .collect();
    Mock::given(method("POST"))
        .and(path("/bar-coords"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_json(serde_json::json!({ "coords": coords })))
        .mount(&mock_server)
        .await;

    Mock::given(method("POST"))
        .and(path("/rasterise"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_bytes(EMPTY_ZIP.to_vec()))
        .mount(&mock_server)
        .await;

    let opts = common::TestOpts {
        sidecar_url: Some(mock_server.uri().parse().unwrap()),
        ..Default::default()
    };
    let app = common::spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_pdf_with_app(&app, &cookie).await;

    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/rasterise")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    let row: (Option<String>,) = sqlx::query_as(
        "SELECT page_blob_keys_json FROM accompaniments WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!(row.0.is_none());

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 31 — /omr 503 → POST /parts → 503 sidecar_unavailable; /healthz → 200
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_parts_sidecar_503_returns_503() {
    let mock_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/omr"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&mock_server)
        .await;

    let opts = common::TestOpts {
        sidecar_url: Some(mock_server.uri().parse().unwrap()),
        ..Default::default()
    };
    let app = common::spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_pdf_with_app(&app, &cookie).await;

    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/parts")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 503);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "sidecar_unavailable");

    let health = app.client.get(app.url("/healthz")).send().await.unwrap();
    assert_eq!(health.status(), 200);

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Test 32 — /omr ok + /list-parts INVALID_MUSICXML → 422 sidecar_bad_input
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_parts_list_parts_bad_input_returns_422() {
    let mock_server = MockServer::start().await;
    mount_omr_stub(&mock_server).await;

    Mock::given(method("POST"))
        .and(path("/list-parts"))
        .respond_with(ResponseTemplate::new(422)
            .set_body_json(serde_json::json!({
                "code": "INVALID_MUSICXML",
                "error": "score has no parts",
            })))
        .mount(&mock_server)
        .await;

    let opts = common::TestOpts {
        sidecar_url: Some(mock_server.uri().parse().unwrap()),
        ..Default::default()
    };
    let app = common::spawn_app_with(opts).await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_pdf_with_app(&app, &cookie).await;

    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/parts")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["code"], "sidecar_bad_input");

    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Tests 33–35 — WAV-only asset cannot use PDF-dependent routes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn wav_asset_post_parts_returns_400() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_wav_with_app(&app, &cookie).await;
    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/parts")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn wav_asset_post_midi_returns_400() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_wav_with_app(&app, &cookie).await;
    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/midi")))
        .header("cookie", format!("sb_session={cookie}"))
        .header("content-type", "application/json")
        .body(r#"{"part_indices":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

#[tokio::test]
async fn wav_asset_post_rasterise_returns_400() {
    let app = common::spawn_app().await;
    let cookie = app.signup_teacher("t@test.com", "room-a").await;
    let id = upload_wav_with_app(&app, &cookie).await;
    let r = app.client
        .post(app.url(&format!("/teach/room-a/library/assets/{id}/rasterise")))
        .header("cookie", format!("sb_session={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    app.shutdown().await;
}

// ---------------------------------------------------------------------------
// Shared helpers for the new tests
// ---------------------------------------------------------------------------

async fn upload_pdf_with_app(app: &common::TestApp, cookie: &str) -> i64 {
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Test Score")
        .header("content-type", "application/pdf")
        .body(PDF_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    r.json::<serde_json::Value>().await.unwrap()["id"].as_i64().unwrap()
}

async fn upload_wav_with_app(app: &common::TestApp, cookie: &str) -> i64 {
    let r = app.client
        .post(app.url("/teach/room-a/library/assets"))
        .header("cookie", format!("sb_session={cookie}"))
        .header("x-title", "Test WAV")
        .header("content-type", "audio/wav")
        .body(WAV_HEADER.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    r.json::<serde_json::Value>().await.unwrap()["id"].as_i64().unwrap()
}

async fn mount_omr_stub(server: &MockServer) {
    let omr_body = serde_json::json!({
        "musicxml": base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"<score-partwise></score-partwise>",
        ),
        "page_count": 1u32,
    });
    Mock::given(method("POST"))
        .and(path("/omr"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&omr_body))
        .mount(server)
        .await;
}

async fn mount_extract_midi_stub(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/extract-midi"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_bytes(MIDI_HEADER.to_vec()))
        .mount(server)
        .await;
}

async fn mount_synthesise_stub(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/synthesise"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_bytes(WAV_HEADER.to_vec()))
        .mount(server)
        .await;
}

async fn mount_bar_timings_stub(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/bar-timings"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_json(serde_json::json!({ "timings": [{"bar": 1, "time_s": 0.0}] })))
        .mount(server)
        .await;
}
