# Contributing to geocow

Thanks for taking a look. Bug reports, accuracy questions and pull requests
are all welcome.

## Setup

You need Rust 1.85+, PROJ ≥ 9.4 with headers and pkg-config, and for the web
map Node 22 with Yarn 4 (via `corepack enable`). The OSTN15 grid is committed,
so tests run straight from a clone — run them from the repo root so
`./OSTN15_NTv2` is found.

```sh
cargo test                                           # everything Rust, incl. all 40 OS points
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt
cargo build --no-default-features                    # the lean CLI must keep building

yarn --cwd web install
yarn --cwd web test                                  # vitest
yarn --cwd web build                                 # tsc + vite

cargo run -- serve                                   # API on :8787
yarn --cwd web dev                                   # map on :5173, /api proxied
```

CI runs exactly these, and must be green before merge.

## How we work

- **Red/green TDD.** Write a failing test that describes the behaviour, make
  it pass with the least code, then refactor. No code without a covering test;
  no test without a clear assertion.
- **Accuracy is the product.** Anything touching `crs.rs` must keep the
  40-point OS suite passing at its current tolerances, and must never
  introduce a fallback that runs without the grid.
- **Errors, not guesses.** Library code returns `Result<_, GeocowError>` — no
  `unwrap()`/`expect()` outside tests. Distinguish "you asked for something
  impossible" (`UnsupportedCrs`, a 422) from "we failed" (a 500).
- **One binary.** New functionality is a `geocow` subcommand, named as a verb.
- **No secrets, no deployment specifics.** Keys and hosts are runtime
  configuration via `GEOCOW_*` environment variables.
- Commit messages: imperative mood, a summary line under 72 characters.

[CLAUDE.md](CLAUDE.md) has the fuller conventions — it's written for AI coding
agents but applies to everyone.

## Reporting issues

For a wrong coordinate, please include the input, the command or endpoint,
what you got, and what you expected (ideally with a reference from OS or
another OSTN15 implementation). Security issues: see [SECURITY.md](SECURITY.md).
