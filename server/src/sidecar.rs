// File: server/src/sidecar.rs
// Purpose: HTTP client for the internal Python sidecar — OMR, MIDI extraction,
//          WAV synthesis, rasterisation, bar-timing/coord computation.
// Role: Thin async wrapper; maps sidecar error codes to AppError variants.
// Exports: SidecarClient, OmrResult, PartInfo, BarTiming, BarCoord, SynthesiseRequest, ScoreRenderResult
// Depends: reqwest, bytes, url, auth::secret, error
// Invariants: Bearer token sent on every request.
//             AUDIVERIS_MISSING / FLUIDSYNTH_MISSING / connection failure → SidecarUnavailable.
//             All other sidecar error codes → SidecarBadInput (surfaces as 422).
//             ZIP response from /rasterise is unzipped here; caller receives Vec<(filename, bytes)>.
//             /omr response includes parts + bar_coords so Audiveris runs exactly once per PDF.
// Last updated: Sprint 26 (2026-05-06) -- render_score returns ScoreRenderResult (pages + bar_coords); add list_parts_from_musicxml

use std::time::Duration;

use bytes::Bytes;
use serde::Deserialize;

use crate::auth::secret::SecretString;
use crate::error::{AppError, Result};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct OmrResult {
    pub musicxml: Bytes,
    pub page_count: u32,
    pub parts: Vec<PartInfo>,
    pub bar_coords: Vec<BarCoord>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct PartInfo {
    pub index: i32,
    pub name: String,
    pub instrument: String,
    pub has_notes: bool,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct BarTiming {
    pub bar: i32,
    pub time_s: f64,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct BarCoord {
    pub bar: i32,
    pub page: i32,
    pub x_frac: f64,
    pub y_frac: f64,
    pub w_frac: f64,
    pub h_frac: f64,
}

pub struct ScoreRenderResult {
    pub pages: Vec<(String, Bytes)>,
    pub bar_coords: Vec<BarCoord>,
}

pub struct SynthesiseRequest {
    pub midi: Bytes,
    pub tempo_pct: i32,
    pub transpose_semitones: i32,
    pub respect_repeats: bool,
}

// ---------------------------------------------------------------------------
// Error shape returned by sidecar
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SidecarError {
    code: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

pub struct SidecarClient {
    base: url::Url,
    client: reqwest::Client,
    secret: SecretString,
}

impl SidecarClient {
    pub fn base_url(&self) -> &str {
        self.base.as_str()
    }

    pub fn new(base: url::Url, secret: SecretString) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .expect("reqwest client");
        Self { base, client, secret }
    }

    fn url(&self, path: &str) -> String {
        let base = self.base.as_str().trim_end_matches('/');
        format!("{base}{path}")
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.secret.expose())
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status();
        // Attempt to parse the sidecar error envelope.
        if let Ok(body) = resp.json::<SidecarError>().await {
            return Err(Self::map_code(&body.code, &body.error));
        }
        // Unknown / unparseable error from sidecar.
        if status.is_server_error() {
            Err(AppError::SidecarUnavailable)
        } else {
            Err(AppError::SidecarBadInput("sidecar request failed".into()))
        }
    }

    fn send_err(e: reqwest::Error, endpoint: &str) -> AppError {
        tracing::error!(endpoint, error = %e, "sidecar connection failed");
        AppError::ServiceUnavailable
    }

    fn map_code(code: &str, message: &str) -> AppError {
        match code {
            "AUDIVERIS_MISSING" | "FLUIDSYNTH_MISSING" | "VEROVIO_MISSING" => AppError::SidecarUnavailable,
            _ => AppError::SidecarBadInput(message.to_string().into()),
        }
    }

    // -----------------------------------------------------------------------
    // Endpoints
    // -----------------------------------------------------------------------

    pub async fn healthz(&self) -> Result<()> {
        let resp = self
            .client
            .get(self.url("/healthz"))
            .send()
            .await
            .map_err(|e| Self::send_err(e, "healthz"))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(AppError::ServiceUnavailable)
        }
    }

    pub async fn omr(&self, pdf: Bytes) -> Result<OmrResult> {
        let form = reqwest::multipart::Form::new()
            .part("pdf", reqwest::multipart::Part::bytes(pdf.to_vec()).file_name("input.pdf"));

        let resp = self
            .client
            .post(self.url("/omr"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "omr"))?;

        let resp = Self::check(resp).await?;

        #[derive(Deserialize)]
        struct OmrResponse {
            musicxml: String, // base64
            page_count: u32,
            #[serde(default)]
            parts: Vec<PartInfo>,
            #[serde(default)]
            bar_coords: Vec<BarCoord>,
        }
        let body: OmrResponse = resp.json().await.map_err(|_| AppError::Internal("sidecar omr parse".into()))?;
        let musicxml = base64_decode(&body.musicxml)?;
        Ok(OmrResult {
            musicxml: Bytes::from(musicxml),
            page_count: body.page_count,
            parts: body.parts,
            bar_coords: body.bar_coords,
        })
    }

    pub async fn extract_midi(&self, musicxml: Bytes, part_indices: &[usize]) -> Result<Bytes> {
        let indices_json = serde_json::to_string(part_indices)
            .map_err(|_| AppError::Internal("serialize part_indices".into()))?;

        let form = reqwest::multipart::Form::new()
            .part("musicxml", reqwest::multipart::Part::bytes(musicxml.to_vec()).file_name("score.musicxml"))
            .text("part_indices", indices_json);

        let resp = self
            .client
            .post(self.url("/extract-midi"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "extract-midi"))?;

        let resp = Self::check(resp).await?;
        Ok(resp.bytes().await.map_err(|_| AppError::Internal("sidecar midi bytes".into()))?)
    }

    pub async fn bar_timings(&self, midi: Bytes) -> Result<Vec<BarTiming>> {
        let form = reqwest::multipart::Form::new()
            .part("midi", reqwest::multipart::Part::bytes(midi.to_vec()).file_name("piano.mid"));

        let resp = self
            .client
            .post(self.url("/bar-timings"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "bar-timings"))?;

        let resp = Self::check(resp).await?;

        #[derive(Deserialize)]
        struct TimingsResponse {
            timings: Vec<BarTiming>,
        }
        let body: TimingsResponse = resp.json().await.map_err(|_| AppError::Internal("sidecar timings parse".into()))?;
        Ok(body.timings)
    }

    pub async fn bar_coords(&self, pdf: Bytes) -> Result<Vec<BarCoord>> {
        let form = reqwest::multipart::Form::new()
            .part("pdf", reqwest::multipart::Part::bytes(pdf.to_vec()).file_name("input.pdf"));

        let resp = self
            .client
            .post(self.url("/bar-coords"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "bar-coords"))?;

        let resp = Self::check(resp).await?;

        #[derive(Deserialize)]
        struct CoordsResponse {
            coords: Vec<BarCoord>,
        }
        let body: CoordsResponse = resp.json().await.map_err(|_| AppError::Internal("sidecar coords parse".into()))?;
        Ok(body.coords)
    }

    pub async fn rasterise(&self, pdf: Bytes, dpi: u32) -> Result<Vec<(String, Bytes)>> {
        let form = reqwest::multipart::Form::new()
            .part("pdf", reqwest::multipart::Part::bytes(pdf.to_vec()).file_name("input.pdf"))
            .text("dpi", dpi.to_string());

        let resp = self
            .client
            .post(self.url("/rasterise"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "rasterise"))?;

        let resp = Self::check(resp).await?;
        let zip_bytes = resp.bytes().await.map_err(|_| AppError::Internal("sidecar rasterise bytes".into()))?;
        unzip_pages(&zip_bytes)
    }

    pub async fn render_score(&self, musicxml: Bytes, part_indices: &[usize]) -> Result<ScoreRenderResult> {
        let indices_json = serde_json::to_string(part_indices)
            .map_err(|_| AppError::Internal("part_indices json".into()))?;

        let form = reqwest::multipart::Form::new()
            .part("musicxml", reqwest::multipart::Part::bytes(musicxml.to_vec()).file_name("score.musicxml"))
            .text("part_indices", indices_json);

        let resp = self
            .client
            .post(self.url("/render-score"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "render-score"))?;

        let resp = Self::check(resp).await?;
        let zip_bytes = resp.bytes().await.map_err(|_| AppError::Internal("sidecar render-score bytes".into()))?;
        unzip_score(&zip_bytes)
    }

    pub async fn list_parts_from_musicxml(&self, musicxml: Bytes) -> Result<Vec<PartInfo>> {
        let form = reqwest::multipart::Form::new()
            .part("musicxml", reqwest::multipart::Part::bytes(musicxml.to_vec()).file_name("score.musicxml"));

        let resp = self
            .client
            .post(self.url("/list-parts"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "list-parts"))?;

        let resp = Self::check(resp).await?;

        #[derive(Deserialize)]
        struct ListPartsResponse { parts: Vec<PartInfo> }
        let body: ListPartsResponse = resp.json().await.map_err(|_| AppError::Internal("sidecar list-parts parse".into()))?;
        Ok(body.parts)
    }

    pub async fn synthesise(&self, req: SynthesiseRequest) -> Result<Bytes> {
        let form = reqwest::multipart::Form::new()
            .part("midi", reqwest::multipart::Part::bytes(req.midi.to_vec()).file_name("piano.mid"))
            .text("tempo_pct", req.tempo_pct.to_string())
            .text("transpose_semitones", req.transpose_semitones.to_string())
            .text("respect_repeats", if req.respect_repeats { "1" } else { "0" });

        let resp = self
            .client
            .post(self.url("/synthesise"))
            .header("Authorization", self.auth())
            .multipart(form)
            .send()
            .await
            .map_err(|e| Self::send_err(e, "synthesise"))?;

        let resp = Self::check(resp).await?;
        Ok(resp.bytes().await.map_err(|_| AppError::Internal("sidecar synthesise bytes".into()))?)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| AppError::Internal("base64 decode".into()))
}

fn unzip_score(zip_bytes: &[u8]) -> Result<ScoreRenderResult> {
    use std::io::{Cursor, Read};

    let cursor = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|_| AppError::Internal("zip parse".into()))?;

    let mut pages: Vec<(String, Bytes)> = Vec::new();
    let mut bar_coords: Vec<BarCoord> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|_| AppError::Internal("zip entry".into()))?;
        let name = file.name().to_string();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|_| AppError::Internal("zip read".into()))?;

        if name == "bar_coords.json" {
            if let Ok(coords) = serde_json::from_slice::<Vec<BarCoord>>(&buf) {
                bar_coords = coords;
            }
        } else {
            pages.push((name, Bytes::from(buf)));
        }
    }
    pages.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(ScoreRenderResult { pages, bar_coords })
}

fn unzip_pages(zip_bytes: &[u8]) -> Result<Vec<(String, Bytes)>> {
    use std::io::{Cursor, Read};

    let cursor = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|_| AppError::Internal("zip parse".into()))?;

    let mut pages = Vec::new();
    let file_count = archive.len();
    for i in 0..file_count {
        let mut file = archive.by_index(i)
            .map_err(|_| AppError::Internal("zip entry".into()))?;
        let name = file.name().to_string();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|_| AppError::Internal("zip read".into()))?;
        pages.push((name, Bytes::from(buf)));
    }
    pages.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(pages)
}
