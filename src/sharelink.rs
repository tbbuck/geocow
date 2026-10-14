//! Share-link encoding, shared by `geocow map` and the server.
//!
//! The web app packs pasted geometry into the URL hash as gzip + base64url
//! (`#d=...`) and decodes it with the browser's DecompressionStream. This
//! module produces byte-compatible payloads from Rust, so `pbpaste |
//! geocow map` opens the same map the Share button would, and a geometry
//! POSTed to `/api/geometry` is stored in the same form a browser share is.

use std::io::{Read, Write};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

use crate::error::GeocowError;

/// gzip + base64url-encode text into a share payload (the `d=` hash value).
pub fn encode_share_payload(text: &str) -> Result<String, GeocowError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(text.as_bytes())?;
    let compressed = encoder.finish()?;
    Ok(URL_SAFE_NO_PAD.encode(compressed))
}

/// Inverse of [`encode_share_payload`] — used in tests to prove round-trips
/// and decode payloads produced by the browser.
pub fn decode_share_payload(payload: &str) -> Result<String, GeocowError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| GeocowError::InvalidGeometry(format!("bad base64url: {e}")))?;
    let mut decoder = GzDecoder::new(&bytes[..]);
    let mut out = String::new();
    decoder.read_to_string(&mut out)?;
    Ok(out)
}

/// Build the launch URL: `<base>/#d=<payload>` (data-only hash; the map fits
/// to the geometry since no viewport is supplied).
pub fn build_url(base: &str, payload: &str) -> String {
    let base = base.trim_end_matches('/');
    format!("{base}/#d={payload}")
}

/// Build the short-link URL for a payload already in the share store:
/// `<base>/#s=<id>`. Same data-only, fit-to-geometry contract as
/// [`build_url`], but the geometry travels in the store rather than the URL.
pub fn share_id_url(base: &str, id: &str) -> String {
    let base = base.trim_end_matches('/');
    format!("{base}/#s={id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_geojson() {
        let text = r#"{"type":"Point","coordinates":[-1.5,52.4]}"#;
        let payload = encode_share_payload(text).unwrap();
        assert_eq!(decode_share_payload(&payload).unwrap(), text);
    }

    #[test]
    fn build_url_strips_trailing_slash() {
        assert_eq!(
            build_url("http://127.0.0.1:8787/", "abc"),
            "http://127.0.0.1:8787/#d=abc"
        );
        assert_eq!(
            build_url("https://geocow.uk", "abc"),
            "https://geocow.uk/#d=abc"
        );
    }

    #[test]
    fn share_id_url_uses_the_short_link_hash() {
        assert_eq!(
            share_id_url("https://geocow.uk/", "an-id"),
            "https://geocow.uk/#s=an-id"
        );
        assert_eq!(
            share_id_url("http://127.0.0.1:8787", "an-id"),
            "http://127.0.0.1:8787/#s=an-id"
        );
    }

    #[test]
    fn decodes_browser_produced_payload() {
        // Captured from the web app's Share button (CompressionStream gzip) for
        // exactly this text — proves the Rust and JS codecs are interoperable.
        let payload = "H4sIAAAAAAAAEwvw9_QL0dA11DNVMDXSM9EEAGEFfXsQAAAA";
        assert_eq!(decode_share_payload(payload).unwrap(), "POINT(-1.5 52.4)");
    }
}
