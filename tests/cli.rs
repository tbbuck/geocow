use std::io::Write;
use std::process::{Command, Stdio};

fn geocow_bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_geocow"))
}

fn geocow_with_stdin(args: &[&str], stdin_data: &str) -> std::process::Output {
    let mut child = geocow_bin()
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn geocow");

    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin_data.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn startup_fails_without_grid_files() {
    let temp = std::env::temp_dir().join("geocow_test_no_grid");
    std::fs::create_dir_all(&temp).unwrap();

    let output = geocow_bin()
        // Point grid search at an empty directory so files aren't found
        .env("GEOCOW_GRID_DIR", &temp)
        // Clear CWD-relative search by running from the temp dir
        .current_dir(&temp)
        .output()
        .expect("failed to execute geocow");

    let code = output.status.code().expect("process should have exit code");
    assert_eq!(code, 2, "expected exit code 2 for missing grid files");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("OSTN15"),
        "stderr should mention OSTN15, got:\n{stderr}"
    );
    assert!(
        stderr.contains(".gsb"),
        "stderr should mention .gsb files, got:\n{stderr}"
    );
    assert!(
        stderr.contains("Ordnance Survey") || stderr.contains("GEOCOW_GRID_DIR"),
        "stderr should hint at how to obtain/configure grid files, got:\n{stderr}"
    );
}

#[test]
fn help_works_with_valid_grid() {
    let output = geocow_bin()
        .arg("--help")
        .output()
        .expect("failed to execute geocow");

    let code = output.status.code().expect("process should have exit code");
    assert_eq!(code, 0, "expected exit code 0 for --help");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("geocow"),
        "help output should contain 'geocow', got:\n{stdout}"
    );
}

#[test]
#[cfg(all(feature = "serve", feature = "map"))]
fn help_lists_every_subcommand() {
    let output = geocow_bin().arg("--help").output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    for sub in ["transform", "serve", "map"] {
        assert!(
            stdout.contains(sub),
            "--help should list `{sub}`:\n{stdout}"
        );
    }
}

// ---------------------------------------------------------------
// map — open geometry on a geocow map
// ---------------------------------------------------------------

#[test]
#[cfg(feature = "map")]
fn map_print_emits_an_inline_share_url() {
    let output = geocow_with_stdin(
        &["map", "--print", "--url", "http://maps.example.test/"],
        "POINT(-1.54 53.79)",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let payload = url
        .strip_prefix("http://maps.example.test/#d=")
        .unwrap_or_else(|| panic!("unexpected url: {url}"));
    assert_eq!(
        geocow::sharelink::decode_share_payload(payload).unwrap(),
        "POINT(-1.54 53.79)"
    );
}

#[test]
#[cfg(feature = "map")]
fn map_reads_a_file_argument() {
    let path = std::env::temp_dir().join("geocow_map_test.wkt");
    std::fs::write(&path, "POINT(1 52)\n").unwrap();
    let output = geocow_bin()
        .args(["map", "--print", "--url", "http://x.test"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).starts_with("http://x.test/#d="));
}

#[test]
#[cfg(feature = "map")]
fn map_rejects_unparseable_input_before_opening_anything() {
    let output = geocow_with_stdin(&["map", "--print"], "NOT_VALID_GEOMETRY");
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty(), "no URL should be printed");
}

#[test]
#[cfg(feature = "map")]
fn map_rejects_empty_input() {
    let output = geocow_with_stdin(&["map", "--print"], "  \n");
    assert_eq!(output.status.code(), Some(1));
}

// ---------------------------------------------------------------
// Transform CLI subcommand
// ---------------------------------------------------------------

#[test]
fn transform_wkt_point_to_27700() {
    let output = geocow_with_stdin(&["transform", "--to", "27700"], "POINT(-1.54 53.79)");

    assert!(output.status.success(), "expected success");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    assert!(
        trimmed.starts_with("POINT("),
        "expected WKT output, got: {trimmed}"
    );
    // Output should contain easting/northing values (not lat/lon)
    // -1.54, 53.79 in ETRS89 is roughly (429000, 387000) in OSGB36
    assert!(
        !trimmed.contains("-1.54"),
        "output should not contain input lon: {trimmed}"
    );
}

#[test]
fn transform_default_from_is_4258() {
    // Without --from should produce same result as --from 4258
    let without = geocow_with_stdin(&["transform", "--to", "27700"], "POINT(-1.54 53.79)");
    let with_explicit = geocow_with_stdin(
        &["transform", "--from", "4258", "--to", "27700"],
        "POINT(-1.54 53.79)",
    );

    assert!(without.status.success());
    assert!(with_explicit.status.success());
    assert_eq!(
        without.stdout, with_explicit.stdout,
        "implicit and explicit --from 4258 should produce identical output"
    );
}

#[test]
fn transform_reverse_27700_to_4258() {
    // Transform forward then reverse — result should be WKT with lat/lon
    let fwd = geocow_with_stdin(&["transform", "--to", "27700"], "POINT(-1.54 53.79)");
    assert!(fwd.status.success());
    let osgb_wkt = String::from_utf8_lossy(&fwd.stdout).trim().to_string();

    let rev = geocow_with_stdin(&["transform", "--from", "27700", "--to", "4258"], &osgb_wkt);
    assert!(rev.status.success());
    let stdout = String::from_utf8_lossy(&rev.stdout);
    assert!(
        stdout.trim().starts_with("POINT("),
        "expected WKT POINT, got: {}",
        stdout.trim()
    );
}

#[test]
fn transform_geojson_autodetected() {
    let input = r#"{"type":"Point","coordinates":[-1.54,53.79]}"#;
    let output = geocow_with_stdin(&["transform", "--to", "27700"], input);

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    assert!(
        trimmed.starts_with('{'),
        "output should be GeoJSON, got: {trimmed}"
    );
    assert!(
        trimmed.contains("coordinates"),
        "output should contain coordinates: {trimmed}"
    );
}

#[test]
fn transform_invalid_wkt_error() {
    let output = geocow_with_stdin(&["transform", "--to", "27700"], "NOT_VALID_GEOMETRY");

    assert!(!output.status.success());
    let code = output.status.code().unwrap();
    assert_eq!(code, 1, "expected exit code 1 for user error");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.is_empty(), "should have error message on stderr");
}
