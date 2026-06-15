# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-b1] - 2026-06-15

### Added

- Runtime folder registration via CRUD API (`GET`, `POST`, `PUT`, `DELETE`)
- Slug-based routing with automatic URL-safe slugs
- Subdomain access (`slug.localhost`) alongside path-based URLs
- File serving with auto MIME detection, range requests (206), ETags, and conditional responses (304)
- HTML directory browsing with parent links and file sizes
- Self-contained HTML dashboard for visual management
- MCP stdio server mode (`--mcp stdio`) for AI agent integration
- Optional `registry.json` persistence (`PERSIST=true`)
- Path traversal protection
- Multi-platform executable builds (Linux x64/arm64, Windows x64, macOS x64/arm64)
- GitHub Actions release workflow (builds all platforms on `v*` tag push)

### Changed

- Default port from `8080` to `6868`
- Migrated test suite from bash to `bun:test` (16 MCP tests + CRUD / persistence tests)
- Split monolithic `index.ts` into 8 modular `src/` files (`cli`, `registry`, `slug`, `handlers`, `http`, `mcp`, `utils`)

### Fixed

- Event handlers broken by `setAttribute` in dashboard
- Route subdomain requests to file serving instead of API
- Infinite loop and test failures in early iterations
- Llama-swap URL in acknowledgments
