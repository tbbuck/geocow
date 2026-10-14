use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::io::Read;

#[derive(Parser)]
#[command(
    name = "geocow",
    version,
    about = "ETRS89 <-> British National Grid via OSTN15: CLI, HTTP API and map"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Transform WKT or GeoJSON on stdin between EPSG:4258 and EPSG:27700
    Transform {
        /// Source CRS EPSG code
        #[arg(long, default_value_t = 4258)]
        from: u32,
        /// Target CRS EPSG code
        #[arg(long, default_value_t = 4258)]
        to: u32,
    },

    /// Serve the web map and HTTP API
    #[cfg(feature = "serve")]
    Serve {
        /// Address to listen on
        #[arg(long, env = "GEOCOW_BIND", default_value = "127.0.0.1:8787")]
        bind: std::net::SocketAddr,
        /// Directory holding the built frontend
        #[arg(long, env = "GEOCOW_WEB_DIR", default_value = "web/dist")]
        web_dir: std::path::PathBuf,
    },

    /// Open WKT or GeoJSON (a file, or stdin) on a geocow map in the browser
    #[cfg(feature = "map")]
    Map {
        /// Geometry file to read. Omit, or pass `-`, to read stdin.
        #[arg(value_name = "FILE")]
        file: Option<std::path::PathBuf>,
        /// Base URL of the geocow map to open
        #[arg(long, env = "GEOCOW_URL", default_value = geocow::launch::DEFAULT_MAP_URL)]
        url: String,
        /// Browser to open (an application name on macOS); default: the system's
        #[arg(long, env = "GEOCOW_BROWSER")]
        browser: Option<String>,
        /// Print the URL instead of opening a browser
        #[arg(long)]
        print: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // Hard startup gate: nothing runs without a valid grid.
    if let Err(e) = geocow::crs::validate_grid() {
        eprintln!("Error: {e}\n");
        eprintln!("geocow requires the OSTN15 NTv2 grid shift file to operate.");
        eprintln!("It ships in the repo at OSTN15_NTv2/OSTN15_NTv2_OSGBtoETRS.gsb.\n");
        eprintln!("To fix this:");
        eprintln!("  1. Run geocow from the repo root, so ./OSTN15_NTv2/ is found; or");
        eprintln!("  2. Put OSTN15_NTv2/OSTN15_NTv2_OSGBtoETRS.gsb next to the binary; or");
        eprintln!("  3. Set GEOCOW_GRID_DIR to the directory containing the .gsb file");
        eprintln!("If the file is missing, obtain OSTN15 NTv2 from Ordnance Survey.");
        std::process::exit(2);
    }

    match cli.command {
        Some(Commands::Transform { from, to }) => {
            let input = read_stdin()?;
            let input = input.trim();

            let format = geocow::io::detect_format(input);
            let geom = geocow::io::parse_auto(input)?;
            let transformed = geocow::crs::transform(&geom, from, to)?;

            let output = match format {
                geocow::io::Format::Wkt => geocow::io::to_wkt(&transformed),
                geocow::io::Format::GeoJson => geocow::io::to_geojson(&transformed),
            };
            println!("{output}");
        }

        #[cfg(feature = "serve")]
        Some(Commands::Serve { bind, web_dir }) => {
            tracing_subscriber::fmt()
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| geocow::web::DEFAULT_LOG_FILTER.into()),
                )
                .init();
            tracing::info!("OSTN15 grid validated");
            tokio::runtime::Runtime::new()
                .context("failed to start the async runtime")?
                .block_on(geocow::web::serve(bind, web_dir))
                .with_context(|| format!("server on {bind} failed"))?;
        }

        #[cfg(feature = "map")]
        Some(Commands::Map {
            file,
            url,
            browser,
            print,
        }) => {
            let input = match file.as_deref() {
                Some(path) if path.as_os_str() != "-" => std::fs::read_to_string(path)
                    .with_context(|| format!("failed to read {}", path.display()))?,
                _ => read_stdin()?,
            };
            let map_url = geocow::launch::map_url(&url, &input)?;
            // Only echo the URL when asked: on a large geometry it is enormous.
            if print {
                println!("{map_url}");
            } else {
                geocow::launch::open_url(&map_url, browser.as_deref())?;
            }
        }

        None => {}
    }

    Ok(())
}

fn read_stdin() -> Result<String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("failed to read stdin")?;
    Ok(input)
}
