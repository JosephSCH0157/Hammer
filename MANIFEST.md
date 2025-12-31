MANIFEST — Hammer v0.01
0. Summary

Hammer is a browser-based video editing tool for Podcaster’s Forge that replaces Descript-style “AI-assisted editing” workflows with a local-first, engine-agnostic pipeline:

Import video (≤ 90 minutes)

Generate transcript

Detect retakes (suggested cuts) + allow keep/remove

Apply “Studio Sound” preset

Blur background

Suggest and export 9:16 shorts with layout templates (single / split speakers / stacked clip + channel panel)

Export full edited video and selected shorts

Hammer is built around stable project JSON + swappable engines so future “market mode” (TONGS-backed storage, optional cloud rendering) does not force a rewrite.

1. Hard Constraints (v0.01)

Browser-only (no local helper app required)

TypeScript end-to-end

Max input duration: 90 minutes (hard stop with clear message)

Non-destructive editing: source media unchanged; edits are an EDL

Project is portable: no absolute file paths; only asset IDs + metadata

Renderer is a black box: Editor produces a RenderPlan, renderer executes it

2. Non-Goals (v0.01)

Multi-track timeline editing (beyond cuts + effects)

Advanced color grading

Perfect speaker diarization / automatic split-crop tracking

Multi-user collaboration (TONGS will enable later)

Full cloud rendering (v0.01 keeps render local in browser)

3. Product Requirements
3.1 Import + Transcript

Input: MP4 / MOV (and common web formats supported by browser)

Output:

Transcript with time-coded segments:

segments: [{ startMs, endMs, text }]

word-level timestamps optional (nice-to-have, not required)

Acceptance:

Import a 30–90 minute video and display a transcript synced to playback.

Clicking transcript seeks playback to the segment start.

3.2 Retakes Detection + Decision UI

Detect retakes using heuristics:

repeated phrases/sentences close in time

restart markers (“scratch that”, “again”, “take two”, “sorry”)

long pause + repeated sentence start

UI:

“Retakes” panel shows candidates with reason + confidence

Each candidate: Keep / Cut

Cutting creates an EDL range: { startMs, endMs, reason }

Acceptance:

User can approve/remove retake suggestions.

Playback preview respects EDL cuts (skips cut ranges).

3.3 Studio Sound

Provide a one-button audio improvement preset.

v0.01 pipeline (minimum):

gentle compressor

limiter

normalization target (approximation acceptable v0.01)

optional simple noise gate (safe + cheap)

Acceptance:

Toggle “Studio Sound” ON/OFF.

Exported audio differs meaningfully (louder/cleaner) when ON.

3.4 Background Blur

Blur the background while keeping subject sharp-ish.

v0.01:

Person segmentation mask

Blur amount slider

Feather slider

Acceptance:

Preview shows blur effect on playback.

Export includes blur effect (may be slower).

3.5 Shorts

Shorts must export 9:16 with layout templates:

Single (one crop region)

Split (top/bottom speaker layout)

Stacked (video + channel panel containing thumbnail + optional title/handle)

Short Suggestions v0.01:

transcript-driven (punchy segments, strong lines, topic shifts)

present list of suggested clips (15–60s default range)

UI:

Suggested shorts list

Clip preview

Trim handles for in/out

Layout picker

Manual crop boxes for each region (fast drag/resize)

Acceptance:

Export at least one 9:16 short with each layout type.

“Stacked” layout includes user-chosen thumbnail asset.

4. Future: TONGS as the Brain

Hammer must treat storage and assets as provider-driven.

4.1 StorageProvider abstraction (v0.01 ships Local only)

Hammer reads/writes through StorageProvider:

LocalProvider (IndexedDB + File System Access API where available)

TongsProvider (interface + stubs; implemented later)

TONGS responsibilities (future):

mount registry by role (assets/exports/projects)

cross-device continuity + versioning

asset library (channel thumbnails, overlays)

project indexing/search

Hammer responsibilities:

never hardcode paths

store only assetId + metadata

assetId is namespaced by provider id (e.g., local:abc123)

ProjectDoc is the portable truth

Storage invariants:

Storage calls must never hang; every API resolves/rejects deterministically.

IndexedDB open failures must not poison future attempts (cache cleared on failure).

onblocked is treated as a failure with a recoverable retry path.

Manual validation: open Hammer in two tabs; ensure IDB blocked shows actionable error (close other tab and retry) and never hangs.

5. Architecture
5.1 Data Model (Canonical)

ProjectDoc (saved as JSON, versioned):

type ProjectDoc = {
  schemaVersion: "0.1";
  projectId: string;
  createdAt: string;
  updatedAt: string;

  source: {
    assetId: string;        // media asset in provider
    filename: string;
    durationMs: number;
    width: number;
    height: number;
    fps?: number;
  };

  transcript?: Transcript;

  edl: {
    cuts: Array<{ startMs: number; endMs: number; reason: string; enabled: boolean }>;
  };

  effects: {
    audio: { preset: "off" | "studio_clean"; params?: Record<string, number | boolean> };
    video: {
      backgroundBlur?: { enabled: boolean; amount: number; feather: number };
    };
    captions?: { enabled: boolean; styleId?: string }; // optional v0.01
  };

  shorts: Array<ShortClip>;

  assets: {
    // logical assets referenced by the project (thumbnail panels etc.)
    referencedAssetIds: string[];
  };
};

type Transcript = {
  engine: string;
  language?: string;
  segments: Array<{ startMs: number; endMs: number; text: string }>;
};

type ShortClip = {
  id: string;
  title?: string;
  startMs: number;
  endMs: number;
  layout: ShortLayout;
};

type ShortLayout =
  | { kind: "single"; crop: CropRect }
  | { kind: "split"; top: CropRect; bottom: CropRect; gutterPx: number }
  | { kind: "stacked"; video: CropRect; panel: BrandPanel };

type CropRect = { x: number; y: number; w: number; h: number }; // normalized 0..1
type BrandPanel = {
  heightRatio: number;       // 0..1 of 9:16 height
  thumbnailAssetId: string;
  titleText?: string;
  handleText?: string;
};

5.2 Engine Interfaces (Swap Later)
interface TranscribeEngine {
  id: string;
  transcribe(asset: MediaAssetRef, opts: { language?: string }): Promise<Transcript>;
}

interface RetakeEngine {
  id: string;
  detect(transcript: Transcript): Promise<Array<{ startMs: number; endMs: number; reason: string; confidence: number }>>;
}

interface RenderEngine {
  id: string;
  exportFull(project: ProjectDoc, plan: RenderPlan): Promise<ExportResult>;
  exportShort(project: ProjectDoc, shortId: string, plan: RenderPlan): Promise<ExportResult>;
}

interface StorageProvider {
  id: string;
  putAsset(file: File): Promise<{ assetId: string; meta: any }>;
  getAsset(assetId: string): Promise<Blob>;
  saveProject(doc: ProjectDoc): Promise<void>;
  loadProject(projectId: string): Promise<ProjectDoc>;
  listProjects(): Promise<Array<{ projectId: string; updatedAt: string; title?: string }>>;
}

5.3 RenderPlan (Editor/Renderer boundary)

Editor produces an explicit plan:

cut ranges

effects params

shorts layout + crops

output config

Renderer is free to implement internally (WASM, WebCodecs, etc).

6. UI (v0.01 Panels)

Minimal, shippable layout:

Top bar: Project name, Export, Settings, Help

Left panel: Tabs

Transcript

Retakes

Shorts

Effects

Assets (thumbnail picker)

Center: Video preview + overlay controls (crop boxes)

Bottom: Timeline scrubber with cut markers + short ranges

Required interactions

Seek by clicking transcript

Toggle retake cuts

Create/edit short clip ranges

Choose layout template + adjust crop boxes

Toggle Studio Sound + blur parameters

Export full + export selected shorts

7. Repo Layout (TypeScript, no monolith)
hammer/
  README.md
  MANIFEST.md
  package.json
  tsconfig.json
  vite.config.ts
  src/
    app/
      bootstrap.ts
      routes.ts
      state/
        store.ts
        projectSlice.ts
        uiSlice.ts
    core/
      types/
        project.ts
        transcript.ts
        engine.ts
      time/
        timecode.ts
        ranges.ts
    providers/
      storage/
        storageProvider.ts
        localProvider.ts
        tongsProvider.stub.ts
    engines/
      transcribe/
        transcribeEngine.ts
        whisperWasmEngine.ts   // placeholder wiring in v0.01
      retakes/
        retakeEngine.ts
        heuristicRetakes.ts
      render/
        renderEngine.ts
        webcodecsRenderEngine.ts // v0.01 target
    features/
      ingest/
        importMedia.ts
        mediaMeta.ts
      transcript/
        transcriptView.tsx
        transcriptSync.ts
      retakes/
        detectRetakes.ts
        retakesPanel.tsx
      effects/
        audioStudio.ts
        blurSegmentation.ts
        effectsPanel.tsx
      shorts/
        suggestShorts.ts
        shortsPanel.tsx
        layouts.ts
        cropOverlay.tsx
    ui/
      components/
        Button.tsx
        Tabs.tsx
        Slider.tsx
        Timeline.tsx
      pages/
        EditorPage.tsx
        ProjectPickerPage.tsx
    styles/
      app.css
    main.tsx
  public/
    icons/

8. Build Milestones (v0.01)
M0 — Skeleton

Vite + TS + basic editor shell

LocalProvider saves/loads ProjectDoc

M1 — Ingest + Playback + Timeline

Import media

Compute duration + meta

Scrub timeline

M2 — Transcript

TranscribeEngine integration (WASM-based or placeholder engine for wiring)

Transcript panel + click-to-seek

M3 — Retakes

Heuristic retake detection

Approve/disable cuts

Preview playback respects cuts

M4 — Export Full (Cuts only)

RenderEngine exports full MP4 with cuts (baseline “we can ship” milestone)

M5 — Studio Sound

Audio preset params + export applies audio chain

M6 — Blur Background

Preview + export applies blur effect

M7 — Shorts 9:16 + Layouts

Suggested shorts list

Layout templates + crop UI

Export shorts as 9:16

9. Quality Gates (minimum)

npm run typecheck must pass

npm run lint must pass

No “monolithic” file: soft cap 500 lines per module (split if bigger)

ProjectDoc schemaVersion bump only when necessary; keep migrations explicit

10. v0.01 “Definition of Done”

A user can:

import a 30–90 min podcast video

generate transcript

accept retake removals

enable Studio Sound + Background Blur

create/accept suggested shorts

export:

one full edited MP4

at least one 9:16 short for each layout type (single/split/stacked)

11. Notes / Risk Callouts (browser-only reality)

Long exports may be slower; provide “Draft/Final” export quality toggles if needed.

Memory ceilings are real; enforce 90-min cap and warn on high-res sources.

Speaker split in v0.01 is manual crop (fast + reliable). Automated speaker tracking is v0.02+.
