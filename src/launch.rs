//! `geocow map`: pipe WKT/GeoJSON in, open it on a geocow map.
//!
//! ```text
//! pbpaste | geocow map
//! ```
//!
//! Validates the input parses, packs it into the same gzip+base64url share
//! hash the web app uses, and opens the browser at `<url>/#d=<payload>`. The
//! map fits to the geometry; EPSG:27700 input is reprojected on load.

use std::process::Command;

use crate::error::GeocowError;
use crate::{io, sharelink};

/// Default map to open: the public instance. Override with `--url` or
/// `GEOCOW_URL` to point at your own.
pub const DEFAULT_MAP_URL: &str = "https://geocow.uk";

/// Validate `input` and build the URL that displays it on the map at `base`.
///
/// Fails on empty or unparseable input, so nothing is opened for garbage.
pub fn map_url(base: &str, input: &str) -> Result<String, GeocowError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(GeocowError::InvalidGeometry(
            "no input — try `pbpaste | geocow map` or `geocow map file.geojson`".into(),
        ));
    }
    io::parse_to_feature_collection(input)?;
    let payload = sharelink::encode_share_payload(input)?;
    Ok(sharelink::build_url(base, &payload))
}

/// The command that opens `url`: in `browser` when given (an application
/// name on macOS, an executable elsewhere), otherwise in the system default.
pub fn browser_command(url: &str, browser: Option<&str>) -> Command {
    if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        if let Some(b) = browser {
            c.args(["-a", b]);
        }
        c.arg(url);
        c
    } else if cfg!(target_os = "windows") {
        // `start`'s first quoted argument is a window title, hence the "".
        let mut c = Command::new("cmd");
        c.args(["/C", "start", ""]);
        if let Some(b) = browser {
            c.arg(b);
        }
        c.arg(url);
        c
    } else {
        let mut c = Command::new(browser.unwrap_or("xdg-open"));
        c.arg(url);
        c
    }
}

/// Open `url` in a browser, failing if the opener can't be run or reports
/// failure.
pub fn open_url(url: &str, browser: Option<&str>) -> Result<(), GeocowError> {
    let mut command = browser_command(url, browser);
    let status = command.status()?;
    if !status.success() {
        return Err(GeocowError::Io(std::io::Error::other(format!(
            "browser opener {:?} exited with {status}",
            command.get_program()
        ))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(c: &Command) -> Vec<String> {
        c.get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn map_url_round_trips_the_input() {
        let url = map_url("https://maps.example/", " POINT(1 52) \n").unwrap();
        let payload = url.strip_prefix("https://maps.example/#d=").unwrap();
        assert_eq!(
            sharelink::decode_share_payload(payload).unwrap(),
            "POINT(1 52)"
        );
    }

    #[test]
    fn map_url_rejects_empty_and_unparseable_input() {
        assert!(map_url(DEFAULT_MAP_URL, "  ").is_err());
        assert!(map_url(DEFAULT_MAP_URL, "NOT GEOMETRY").is_err());
    }

    #[test]
    fn opens_the_system_default_browser_unless_told_otherwise() {
        let c = browser_command("https://x", None);
        assert_eq!(args(&c).last().map(String::as_str), Some("https://x"));
        if cfg!(target_os = "macos") {
            assert_eq!(c.get_program(), "open");
            assert_eq!(args(&c), ["https://x"]);
        } else if cfg!(target_os = "linux") {
            assert_eq!(c.get_program(), "xdg-open");
        }
    }

    #[test]
    fn a_named_browser_is_used() {
        let c = browser_command("https://x", Some("Google Chrome"));
        if cfg!(target_os = "macos") {
            assert_eq!(args(&c), ["-a", "Google Chrome", "https://x"]);
        } else if cfg!(target_os = "linux") {
            assert_eq!(c.get_program(), "Google Chrome");
        } else {
            assert!(args(&c).contains(&"Google Chrome".to_string()));
        }
    }
}
