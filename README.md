Hammer

Hammer is a browser-based video editor for podcasters and creators, built as part of Podcaster’s Forge.

Hammer replaces Descript-style AI editing workflows with a local-first, non-destructive, browser-only pipeline that puts creators back in control — no per-video credit burn, no forced cloud dependency.

Hammer focuses on what podcasters actually need:

clean cuts

readable transcripts

fast retake removal

studio-quality audio polish

vertical shorts that look intentional, not hacked together

Why Hammer Exists

Descript (and similar tools) recently shifted to aggressive AI credit pricing that makes routine editing prohibitively expensive for podcasters producing regularly.

Hammer exists to:

eliminate per-edit AI taxes

keep projects portable and transparent

integrate cleanly into Podcaster’s Forge instead of becoming another silo

allow future cloud scaling without rewriting the editor

Hammer is browser-only by design, so the same codebase works in:

local use

beta distribution

future hosted / TONGS-backed deployments

Core Principles

Browser-only
No local helper apps. No OS-specific installers.

TypeScript first
Strong typing, explicit contracts, no monolith files.

Non-destructive editing
Source media is never modified. All edits are stored as decisions.

Engine-agnostic architecture
Transcription, rendering, and detection engines are swappable.

TONGS-ready
Hammer treats storage as a provider. TONGS becomes the brain later.

Features (v0.01)
Import + Transcript

Import podcast video (up to 90 minutes)

Generate a time-coded transcript

Click transcript to seek playback

Retake Detection

Automatically detects likely retakes using heuristics:

repeated phrases

restart markers (“again”, “scratch that”, etc.)

long pauses followed by repetition

Review and approve cuts

All edits are stored as an EDL (Edit Decision List)

Studio Sound

One-button audio polish:

gentle compression

limiting

loudness normalization

Designed for spoken-word clarity

Background Blur

Person segmentation

Adjustable blur strength and edge feather

Preview in editor, applied during export

Shorts (9:16)

Automatically suggests short-form clips from transcript

Export vertical (9:16) shorts with layout templates:

Single speaker

Split speakers (top / bottom)

Stacked layout (video + channel thumbnail panel)

Manual crop boxes for fast, reliable framing

Export full video and shorts independently

What Hammer Is Not (v0.01)

Not a multi-track NLE

Not a color-grading suite

Not a full collaborative editor (TONGS enables this later)

Not cloud-locked

Hammer is intentionally focused on podcast-centric editing.

Architecture Overview

Hammer is built around a portable project document and swappable engines.

ProjectDoc (source of truth)

Source media metadata

Transcript

Edit Decision List (cuts)

Audio / video effects

Short clip definitions

Asset references (thumbnails, branding)

The project format is stable and storage-agnostic.

Engines

Hammer depends on interfaces, not implementations:

TranscribeEngine

RetakeEngine

RenderEngine

StorageProvider

v0.01 ships with browser-based engines and a local storage provider.
Future versions can add cloud or TONGS-powered engines without rewriting the editor.

Storage Model

Hammer reads and writes through a StorageProvider.

v0.01

Local storage (IndexedDB + File System Access where available)

Future

TONGS becomes the authoritative project and asset store

Cross-device continuity

Versioning and asset libraries

Channel branding shared across Forge tools

Hammer never hardcodes filesystem paths.

Repo Structure
src/
  app/          # app bootstrap, routing, state
  core/         # shared types, time math, utilities
  providers/    # storage providers (local, TONGS stub)
  engines/      # transcription, retakes, rendering
  features/     # ingest, transcript, shorts, effects
  ui/           # reusable UI components


No single file should exceed ~500 lines.

Tech Stack

TypeScript

Vite

React

WebAudio API

WebCodecs / Canvas / WASM (where available)

Hammer intentionally avoids platform-specific dependencies.

Development Status

Current version: v0.01 (in development)

Primary goal:

Replace Descript for real-world podcast editing before worrying about marketplace polish.

See MANIFEST.md §1.1 Foundation Guardrails — this project is not a throwaway prototype.

Relationship to Podcaster’s Forge

Hammer is one tool in the Forge pipeline:

TONGS → storage + orchestration

ANVIL → recording

HAMMER → editing

QUENCH → publishing

HEARTH → ideation

Hammer is built to integrate — not compete — with the rest of the Forge.

License / Usage

License to be determined.

This project is currently under active development and not yet released publicly.
