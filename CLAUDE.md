# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SupoClip is an open-source alternative to OpusClip — an AI-powered video clipping tool that transforms long-form content into viral short clips. AGPL-3.0 licensed.

## Development Commands

### Docker (recommended)

```bash
docker-compose up -d              # Start all 5 services
docker-compose up -d --build      # Rebuild after changes
docker-compose logs -f backend    # Debug backend
docker-compose logs -f worker     # Debug video processing
docker-compose down               # Stop all services
```

Services: Frontend (:3107), Backend API (:8000, docs at /docs), Worker (ARQ), Render worker (ARQ, queue `supoclip_render`), Live worker (ARQ, queue `supoclip_live`), PostgreSQL (:5432), Redis (:6379)

### Backend (local)

Uses `uv` (not pip/poetry). Requires Python 3.11+, ffmpeg, running PostgreSQL and Redis.

```bash
cd backend
uv venv .venv && source .venv/bin/activate
uv sync

# API server (uses refactored entry point)
uvicorn src.main:app --reload --host 0.0.0.0 --port 8000

# Worker process (required for video processing)
arq src.workers.tasks.WorkerSettings

# Render worker (renders the clips when CLIP_RENDER_QUEUE=true; compose sets it)
arq src.workers.render.RenderWorkerSettings
```

### Frontend (local)

```bash
cd frontend
pnpm install
pnpm run dev          # Dev server with Turbopack
pnpm run build        # Prisma generate + Next.js build
pnpm run lint
```

### No tests

The project currently has no test files.

## Architecture

### System Overview

```
User → Frontend (Next.js 15) → Backend API (FastAPI) → Redis Queue → ARQ Worker
                                      ↓                                  ↓
                               PostgreSQL ←───────────────────────────────┘
```

Task creation returns immediately (<100ms). Video processing happens asynchronously in the worker. Frontend connects via SSE for real-time progress updates.

### Backend: Layered Architecture

The backend uses the layered application in `main.py`; `main_refactored.py` is a compatibility import:

```
api/routes/          → HTTP handlers (tasks.py, media.py)
services/            → Business logic (task_service.py, video_service.py)
repositories/        → Raw SQL via asyncpg (task_repository.py, clip_repository.py, source_repository.py)
workers/             → ARQ job queue (tasks.py, job_queue.py, progress.py)
utils/               → Thread pool helpers for blocking operations (async_helpers.py)
```

**Key patterns:**
- All DB access goes through repository classes using raw SQL (`text()` queries), not SQLAlchemy ORM
- Blocking operations (video processing, downloads, transcription) wrapped in `run_in_thread()` to avoid blocking the async event loop
- Progress tracking uses Redis pub/sub → SSE to frontend
- Task status flow: `queued → processing → completed/error/cancelled`

### Video Processing Pipeline

1. **Input** → YouTube URL (yt-dlp) or uploaded file. YouTube videos of `YOUTUBE_PARTIAL_DOWNLOAD_MIN_SECONDS`+ (default 20 min) download only their audio first (`youtube_sections.download_youtube_audio`); each clip then fetches just its own minutes (`download_youtube_section`: reads the mp4 `sidx` index and fetches header + first fragment + the part's fragments in 10 MB blocks over 6 connections, ported from SHARINGAN; falls back to an exact ffmpeg cut, then to the whole video). `services/clip_source.py` (`ClipSource`) times clips from the transcript cache and takes the picture from the section (`create_optimized_clip(render_source=...)`); the editor, caption edits and text adjustments use it too
2. **Transcription** → AssemblyAI word-level timestamps (cached as `.transcript_cache.json`, which also stores `source_duration` and `voice_energy_db` so later edits work after the media is gone; `ffprobe_duration` falls back to it)
3. **AI Analysis** → Voice energy per second (`media/voice_energy.py`, from SHARINGAN) marks transcript lines with 🔊/🔊🔊 where the volume jumps above the video's average; the marked transcript goes to the AI and the rerank sees each candidate's peak. Pydantic AI selects viral segments (15-60s each) with virality scoring. Transcripts over 15 min are analysed in 12-min windows (2-min overlap, 3 concurrent), deduplicated, then reranked together in one comparative call (`RERANK_LLM`, default `LLM`); final count scales ~1 clip per 5 min, capped by `MAX_CLIPS` (default 10)
4. **Clip Generation** → MoviePy creates 9:16 clips with:
   - Face-centered cropping: MediaPipe → OpenCV DNN → Haar cascade (fallback chain)
   - Word-synced subtitles from AssemblyAI
   - Custom fonts (TTF files in `backend/fonts/`)
   - Optional transition effects (`backend/transitions/`)
   - Optional B-roll overlays (Pexels API)
   - Caption templates with animation styles
5. **Review** → `CLIP_REVIEW_ENABLED` (default on): one AI call per clip (`ai.review_clip`, rules in `clip_review.py`, from SHARINGAN) reads the transcript before/inside/after with peaks; weak hook → new teaser, missing context → start up to 15 s earlier, dead start → up to 8 s later, cut ending → up to 8 s later, weak title → new `hook_title`. It reads only the transcript, so it runs **before** the render (`TaskService._review_segment`, also in the live worker) and its fixes go into the one render; any failure keeps the chosen moment. Audio is levelled to -14 LUFS in two passes (`loudnorm_filter_for`). The final encode is libx264 `veryfast` CRF 18 (`FINAL_VIDEO_PRESET`/`FINAL_VIDEO_CRF` in `media/common.py`): measured equal to the old `medium` CRF 19 in about half the time. The intermediate cut it starts from is `ultrafast` CRF 12 (`INTERMEDIATE_PRESET`): 2.7x faster than `veryfast` CRF 16 at the same SSIM
6. **Storage** → Clips to `{TEMP_DIR}/clips/`, metadata to PostgreSQL. Each clip is saved and pushed to the page (SSE `clip_ready`) as soon as it renders; a failed clip is skipped and counted in the progress line. A rerun of the same task (worker restart, "Retomar") keeps clips already rendered for the same moments (`reusable_clip_ids` in `task_service.py`)
7. **Render queue** → with `CLIP_RENDER_QUEUE=true` (set by docker-compose) the task's job stops after the analysis and hands the moments to `services/clip_render_queue.py`: a plan in Redis (`render_plan:{task}`, with a run id) and one arq job `render_clip` per clip on queue `supoclip_render`, served by the `render-worker` service (`workers/render.py`, `RENDER_MAX_JOBS` default 1: one clip gets the whole machine). Each clip job queues the task's next clip when it starts, so a task keeps one clip waiting and users' tasks take turns clip by clip. The last clip completes the task (email, source cleanup, show end). A worker that vanishes loses nothing: arq reruns a job cancelled by shutdown, and a crashed worker's job after `RENDER_JOB_TIMEOUT_SECONDS`; a per-clip Redis claim keeps a rerun from saving the clip twice; a job from an older run ("Retomar") does nothing. Helper machines run only the render worker against the same Redis, PostgreSQL and media storage

### Live clipping (`src/live/`, `workers/live.py`)

A live link (Twitch/Kick channel, or a YouTube video with no duration yet) creates a task with source type
`live` (`_detect_live_stream` in `routes/tasks.py`, probing with yt-dlp; at most `LIVE_MAX_CONCURRENT` at once)
and enqueues `watch_live` on the `supoclip_live` queue, served by the `live-worker` compose service (same image).
`LiveSession` (`live/session.py`, adapted from SHARINGAN's live agent):
- **Record:** ffmpeg copies the stream (no re-encode) into `LIVE_PIECE_SECONDS` pieces under
  `TEMP_DIR/live/<task>/pieces`. Pieces are deleted once the AI has read past them (rolling buffer, hard cap
  `LIVE_BUFFER_MAX_SECONDS`); each piece's mono AAC is kept in `audio/` (~20 MB/h).
- **Listen:** each piece is transcribed (AssemblyAI/Whisper, 3 at a time) and its voice energy measured, all on one
  live clock written to `live.transcript_cache.json` next to the never-existing timing path `live.mp4`.
- **Look:** every `LIVE_ANALYSIS_INTERVAL_SECONDS` of new speech, or 45 s after a strong 🔊🔊 peak, `ai.find_live_moments`
  reads the last 5 min; `filter_moments` keeps finished, non-overlapping moments scoring `LIVE_MIN_SCORE`+.
- **Cut:** each moment's minutes (−20 s/+10 s) are joined into `archive/clip-NNN.mkv` (`archive.json` maps them to the
  live clock) and rendered by `create_single_clip` with `LiveClipSource` (+ review), then saved to the task as it is
  ready (SSE `clip_ready`). Editor, caption edits, "Ajustar com IA" and "apply to all" use the archive, kept
  `LIVE_ARCHIVE_DAYS` (cron `purge_live_archives`). Edits wait until the live ends (the task is "processing").
- **Watch:** while it runs the task page embeds the live and its chat (`components/app/live-watch.tsx`, official
  YouTube/Twitch/Kick players; `task.live_embed` saved at creation). `GET /tasks/live/snapshot?url=` grabs the
  stream's current frame (yt-dlp + ffmpeg) so the home page's webcam picker works for lives.
- **Control:** `POST /tasks/{id}/live/stop` `{"discard_queue": bool}` sets Redis `live_stop:` (`"1"`, or `"now"` to
  drop the queued moments) and `live_stop_requested` in the source metadata, so the page shows "Parando" at once
  (`task.live_stopping`). The session stops recording on its next poll, makes no new AI looks, and finishes only the
  clip in assembly (plus the queue unless discarded). Recording also stops at the plan's YouTube duration limit. A
  restarted worker resumes (arq retries, state.json). The live worker runs blocking steps on a 32-thread executor.

### Frontend Architecture

- **Next.js 15** with App Router, React 19, TailwindCSS v4
- **ShadCN UI** (New York style, stone base color, Radix primitives)
- **Better Auth** with Prisma adapter for email/password auth
- **No global state library** — React hooks only (`useState`, `useEffect`, `useSession`)
- All pages use `"use client"` — SSR is minimal
- Prisma client generated to `frontend/src/generated/prisma/` (custom output path)
- Build: `prisma generate && next build` (Prisma generate runs on both build and postinstall)

**Auth flow:** Frontend calls Better Auth → session cookie → passes `user_id` header to backend API

### Database

PostgreSQL 15. Schema in `init.sql` plus the backend's migrations (`backend/src/migrations/sql`, applied by
`init_db` at API startup). The frontend never changes the schema: no `prisma db push` (it dropped every
backend table missing from `schema.prisma`). Mixed naming conventions:
- `tasks`, `sources`, `generated_clips` → snake_case
- `session`, `account`, `verification`, `users` → camelCase (Better Auth)
- UUIDs stored as VARCHAR(36)
- Auto-update triggers on `updated_at`/`updatedAt` columns

## Key Backend Files

| File | Purpose |
|------|---------|
| `src/main_refactored.py` | Compatibility import for existing deployments |
| `src/main.py` | Canonical FastAPI application factory |
| `src/api/routes/tasks.py` | Task CRUD, SSE progress, clip editing endpoints (711 lines) |
| `src/api/routes/media.py` | Fonts, transitions, uploads, templates |
| `src/services/task_service.py` | Task orchestration, clip editing logic (574 lines) |
| `src/services/video_service.py` | Video download, transcription, AI analysis, clip generation |
| `src/workers/tasks.py` | ARQ worker task definitions |
| `src/workers/job_queue.py` | Job queue management |
| `src/workers/progress.py` | Real-time progress via Redis |
| `src/ai.py` | Pydantic AI agents, system prompt, segment validation |
| `src/video_utils.py` | Video processing, cropping, subtitles (~820 lines) |
| `src/clip_editor.py` | Clip trim, split, merge, export presets |
| `src/broll.py` | Pexels API B-roll integration |
| `src/caption_templates.py` | Caption template system |
| `src/config.py` | Environment variable configuration |
| `src/social/` | Social publishing providers (YouTube, TikTok, Instagram): OAuth, upload, metrics |
| `src/services/social_service.py` | Account connections, publish/schedule, metrics refresh, AI performance context |
| `src/repositories/social_repository.py` | `social_accounts`, `social_posts`, `social_post_metrics` SQL |
| `src/api/routes/social.py` | `/social/*` routes |

## API Endpoints (routes in `api/routes/`)

**Task lifecycle:**
- `POST /start-with-progress` — Create task, enqueue to worker (returns task_id)
- `GET /tasks/` — List user tasks
- `GET /tasks/{id}` — Get task with clips
- `GET /tasks/{id}/progress` — SSE real-time progress stream
- `POST /tasks/{id}/cancel` — Cancel processing
- `POST /tasks/{id}/resume` — Resume cancelled/errored task (a live resumes only if still on air)
- `POST /tasks/{id}/live/stop` — Stop recording a live task (the last moments still become clips)
- `DELETE /tasks/{id}` — Delete task

**Clip editing:**
- `PATCH /tasks/{id}/clips/{clip_id}` — Trim clip
- `POST /tasks/{id}/clips/{clip_id}/split` — Split at timestamp
- `POST /tasks/{id}/clips/merge` — Merge selected clips
- `PATCH /tasks/{id}/clips/{clip_id}/captions` — Update captions
- `GET /tasks/{id}/clips/{clip_id}/export?preset=tiktok` — Export with platform preset

**Media:**
- `GET /fonts`, `GET /transitions`, `GET /caption-templates`, `GET /broll/status`
- `POST /upload` — Upload video file
- `GET /clips/{filename}` — Serve generated clips

**Social publishing:**
- `GET /social/providers`, `GET /social/connections` — configured platforms and connected accounts
- `POST /social/connections/{provider}/authorize` + `/callback` — OAuth handshake (session auth only)
- `POST /social/posts` — publish or schedule a clip; `GET /social/posts?task_id=` — list with metrics
- `POST /social/posts/{id}/cancel|retry|refresh-metrics`, `DELETE /social/posts/{id}`
- `GET /social/performance` — metrics by hook type / platform / clip length (also fed into the AI prompt)
- `GET /social/performance/timeseries?days=30` — daily new views from metrics snapshots (Analytics chart)
- `GET /social/media/{token}` — public token-gated clip stream for Instagram

Worker crons (`workers/tasks.py`): every minute `dispatch_scheduled_social_posts`, hourly `refresh_social_metrics`.
Post status flow: `scheduled → queued → publishing → published/failed/cancelled`.

**API keys (programmatic access):**
- `GET /api-keys/` — List the user's API keys (metadata only)
- `POST /api-keys/` — Create a key (plaintext `sk_...` returned exactly once)
- `DELETE /api-keys/{key_id}` — Revoke a key

API keys authenticate `/tasks/*`, `/fonts` and `/upload` directly via
`Authorization: Bearer sk_...` or `x-api-key`. Resolution lives in
`auth_headers.resolve_authenticated_user_id` (API key → DB lookup, else falls
back to the frontend's HMAC-signed session headers). Only the SHA-256 hash is
stored (`api_keys` table). The frontend manages keys at `/settings/api-keys`.

## Creator (affiliate) program

Creators apply at `/settings/creator-program` (public pitch page: `/affiliate`).
Admins approve/decline/revoke in the `/admin` "Creator Program" panel. Logic
lives in `frontend/src/server/affiliates.ts`; applications are the `affiliates`
table (one per user, `slug` cleared on decline).

- **Approve** creates Stripe promotion code `SLUG` on the shared coupon
  `STRIPE_CREATOR_COUPON_ID` (default `creator-20-3mo`, 20% off for 3 months) and
  grants Pro with `subscription_provider = "affiliate"` (Stripe/Apple webhooks
  never clobber it with a non-paid state).
- **Checkout** applies the coupon from a typed/remembered code (`body.code`) or the
  signup `user_acquisition.ref`. The browser remembers validated `?ref=` codes
  (`lib/creator-code.ts`).
- **Emails** go through the backend `POST /account/affiliate-email` (SES): new
  applications to every `is_admin` user, decisions to the applicant.
- **iOS:** creators' free Pro reaches the app through the billing summary
  (`subscription_provider: "affiliate"`). The audience discount on iPhone is an
  App Store offer code: custom codes on the Pro subscription's "Creator offer"
  (20% off for 3 months), added by hand in App Store Connect; admins then mark
  "App Store code added" and the creator page shows `appStoreRedeemUrl(code)`.
  The app's paywall opens Apple's redeem sheet ("Have a creator code?").

## Environment Variables

Required in `.env` (root) or `backend/.env`:

```bash
ASSEMBLY_AI_API_KEY=...              # Required: video transcription
TRANSCRIPTION_LANGUAGE=              # Optional: empty = auto-detect; e.g. es, de, en_us forces it
LLM=google-gla:gemini-3-flash-preview # Format: provider:model-name
GOOGLE_API_KEY=...                   # Or OPENAI_API_KEY / ANTHROPIC_API_KEY
OLLAMA_BASE_URL=http://localhost:11434/v1  # Optional for ollama:* models
OLLAMA_API_KEY=...                   # Optional; required for Ollama Cloud
RERANK_LLM=                          # Optional; model for the long-video candidate rerank (default: LLM)
YOUTUBE_DOWNLOAD_PROVIDER=yt_dlp     # yt_dlp | apify
YOUTUBE_PARTIAL_DOWNLOAD=true        # Long videos: audio first, then each clip's section only
YOUTUBE_PARTIAL_DOWNLOAD_MIN_SECONDS=1200
CLIP_REVIEW_ENABLED=true             # One AI review per clip, before it is rendered
EDITOR_PREFETCH_CLIPS=2              # Clips after the opened one prepared ahead for the editor (0 = off)
CLIP_RENDER_QUEUE=true               # One render job per clip on the render worker (compose default true; bare default false)
RENDER_MAX_JOBS=1                    # Clips one render worker makes at once
RENDER_JOB_TIMEOUT_SECONDS=1800      # Also how long a vanished worker's clip waits before another worker takes it
LIVE_CLIPPING_ENABLED=true           # Live links are recorded and clipped while they stream
LIVE_MAX_CONCURRENT=2                # Lives recorded at once (live-worker max_jobs)
LIVE_PIECE_SECONDS=30                # Recording piece length
LIVE_BUFFER_MAX_SECONDS=1200         # Hard cap on buffered live video
LIVE_ANALYSIS_INTERVAL_SECONDS=120   # New speech between AI looks
LIVE_MIN_SCORE=6                     # Minimum AI score (1-10) for a live moment to become a clip
LIVE_MAX_CLIPS=30
LIVE_MAX_HEIGHT=1080                 # Recording quality cap (720 halves disk and bandwidth)
LIVE_ARCHIVE_DAYS=7                  # How long each live clip's minutes stay for edits

# Optional
PEXELS_API_KEY=...                   # B-roll stock footage
YOUTUBE_OAUTH_CLIENT_ID=...          # Social publishing: Google OAuth client (+ _SECRET)
TIKTOK_CLIENT_KEY=...                # Social publishing: TikTok app (+ TIKTOK_CLIENT_SECRET)
INSTAGRAM_APP_ID=...                 # Social publishing: Meta app with Instagram Login (+ _SECRET)
SOCIAL_PERFORMANCE_MIN_POSTS=3       # Measured posts before AI selection is personalized
SOCIAL_PUBLISHING_ACCESS=all         # Rollout gate: all | admins (admins + allowlist) | off
SOCIAL_PUBLISHING_ALLOWED_EMAILS=    # Comma-separated beta emails when access=admins
REDIS_HOST=localhost                 # Default: localhost
REDIS_PORT=6379                      # Default: 6379
QUEUED_TASK_TIMEOUT_SECONDS=180      # Fail-safe for stuck tasks
TEMP_DIR=/tmp                        # Temp file storage
DATABASE_URL=postgresql+asyncpg://...
BETTER_AUTH_SECRET=...               # Frontend auth secret
```

## Common Workflows

### Adding fonts/transitions

Drop `.ttf` files into `backend/fonts/` or `.mp4` files into `backend/transitions/`. They auto-appear via their respective `GET` endpoints.

### Social publishing & the performance loop

Users connect accounts at `/settings/social` (OAuth via `/api/social/connect/{provider}` →
`/api/social/callback/{provider}` → backend `/social/connections/{provider}/callback`).
Publishing runs in the ARQ worker (`publish_social_post`). Metrics are pulled back hourly into
`social_post_metrics` and summarized by `SocialService.build_performance_context()`, which
`TaskService.process_task` injects into `build_transcript_analysis_prompt(performance_context=...)`.
Personalized analyses skip the shared `processing_cache` analysis entry.

- **Pages:** `/settings/social` (accounts + every scheduled post) and `/analytics` (totals, daily
  views chart, top clips, breakdowns), both in the sidebar. Clips publish from the task page.
- **Rollout gate:** `SOCIAL_PUBLISHING_ACCESS`. Outside the gate every `/social/*` route returns 403
  except `GET /social/providers`, which reports `enabled: false` with all platforms unconfigured
  (so the web and iOS hide publishing) and the disconnect routes (account deletion revokes tokens).
- **iOS app:** `POST .../authorize` with `{"client": "ios"}` prefixes the OAuth state with `m.`; the
  web callback then redirects to `supoclip://social-callback?provider&code&state` and the app
  completes `/callback` with its own session (the state stays bound to the starting user).
- **Platform approvals gate real users:** TikTok only allows sandbox target users until its audit,
  Instagram only app testers until Meta review, and YouTube uploads from an unaudited project stay
  private. Provider app IDs and setup notes are in `docs/configuration.md`.

### Modifying AI clip selection

Edit `backend/src/ai.py`: `simplified_system_prompt` controls selection criteria, `TranscriptSegment` defines the output model, `get_most_relevant_parts_by_transcript()` runs analysis with validation.

### Video processing constraints

- Output: 9:16 vertical format, H.264, even pixel dimensions (`round_to_even()`)
- Subtitles positioned at 75% down the frame
- Virality scoring: `hook_score`, `engagement_score`, `value_score`, `shareability_score` (0-25 each, summed to `virality_score` 0-100)
- Each segment gets an AI-written `hook_title` (3-9 words) burned into the top safe area for the first ~4s (`build_hook_title_ass` in `video_utils.py`), persisted on `generated_clips.hook_title`
- Static talking-head crops get a slow ~5% Ken Burns punch-in (`kenburns_zoom_fragment`); tracked pans and split screens keep their own motion
- Webcam layouts (`WEBCAM_OUTPUT_FORMATS`): `vertical_gameplay` (webcam top), `vertical_gameplay_bottom` (game top),
  `vertical_cam_float` (game full screen, webcam 480 px wide floating at 40,300 with a white border). `vertical_blur`
  puts the whole picture over a blurred fill. The editor mirrors them (`Framing.layout` `gameplay`/`float`,
  `camPosition`, `background: "blur"`).
- `vertical_gameplay` stacks the streamer's webcam (1080x768) over a centre cut of the game (1080x1152). The webcam comes from the user's box (`webcam_region`, 0-1 fractions) or `media/webcam_detection.py` (steady face across ~24 frames, then borders at the first strong jump in per-pixel motion walking out from the face, from the static room to the moving game, so HUD text farther away is not taken for the border; ported from SHARINGAN, MIT). Letterbox bars are trimmed from the game crop via cropdetect. The clip editor keeps this layout: `Framing.layout = "gameplay"` + a `webcam` box (`editor_document.py`, `frontend/src/lib/editor/document.ts`; preview, browser export and server export share the same cut math), seeded at prepare time by `gameplay_framing()` in `editor_service.py` from the same planner
- "Ganho inicial" (`hook_intro` per task; omitted = `HOOK_FIRST_TEASER` with a hard cut): the AI hook line plays first, then a 0.5 s tape-rewind beat (`media/hook_rewind.py`) paints over a placeholder range appended to the teaser, so durations, captions and source maps stay in sync (`timeline.hook_rewind_point`)
- "Ajustar com IA": `POST /tasks/{id}/clips/{clip_id}/adjust` `{"instructions": "começa 3 s antes"}` → `ai.adjust_clip` returns new bounds/title/teaser (validated in `clip_review.apply_adjustment`, 15 s-3 min) and the clip is rendered again from the source (`ClipEditingMixin.adjust_clip_with_text`)
- Assembly show ("Bastidores", `components/app/assembly-show.tsx`): the clip really being made, like an editor. The
  render reports each stage through `ShowReporter` (`src/show.py`; Redis `show:{task}` + SSE `show`, read on page
  load from `GET /tasks/{id}/show`): `momento` → `revisao` (the review's `{score, changes, notes}`) → `cortes` (ranges, teaser count, timed words, `words_per_line` from the
  caption template) → `trecho` (section download) → `enquadramento` (a 480p silent preview of the real cut and a
  filmstrip, served by `GET /tasks/{id}/show/{clip_key}/{preview.mp4|strip.jpg}`, plus the webcam/game regions) →
  `render` → `pronto` (the saved clip), with the task's queue of
  moments. The page draws the preview in a phone with the layout, title and captions, a timeline (title, filmstrip +
  source pieces, caption lines) that follows the playhead, and a source monitor with the crops. A crew of agents
  (`assembly-crew.ts`: Diretor, Legendista, Câmera, Montador, Revisor) builds it on an overlay canvas as each step
  arrives: cursors drag the pieces onto the video track, type the title and drop the caption lines, crop the
  webcam/game on the source and fly each crop into its slot on the phone; each agent's card says what it is doing. New
  ranges for the same clip (versioned preview URL) play the build again. The preview `<video>` must stay laid out
  (Chrome never autoplays a `display:none` video). Files live in `TEMP_DIR/show/<task>` until the next clip/task end.
- Editor preparation (`prepare_editor`) re-renders each clip's source minutes once (`clean.mp4`, the export master) plus
  thumbnails, waveform and the gameplay framing. Opening a clip also prepares the next `EDITOR_PREFETCH_CLIPS`
  (default 2) in list order, one job at a time (`prefetch_next_clip`); opening an already prepared clip moves the
  window forward (the page calls `/editor/prepare` on ready clips too).
- Clip extras (on demand, nothing stored): `GET /tasks/{id}/clips/{clip_id}/cover[/suggest]` renders a cover JPEG (`media/covers.py`), `POST /tasks/{id}/clips/{clip_id}/post-texts` writes TikTok/Instagram/YouTube copy (`ai.generate_post_texts`, owner only)

## iOS App

A native iOS app ships on the App Store
(https://apps.apple.com/us/app/supoclip/id6784760040, app id `6784760040`). Its
source lives outside this repo. It talks to the hosted API and bills through
RevenueCat, which is what `frontend/src/app/api/billing/revenuecat-webhook/`
serves; App Store subscribers are blocked from Stripe checkout/portal by the
"managed through the App Store" guard in the billing routes. The www references
the app via `APP_STORE_ID`/`APP_STORE_URL` in `frontend/src/lib/site.ts`
(Smart App Banner meta, JSON-LD `MobileApplication`, hero badge, footer link).

## YouTube Downloads

`YOUTUBE_DOWNLOAD_PROVIDER` accepts `yt_dlp` (free default) or `apify`.
Apify requires `APIFY_API_TOKEN` and explicit worker configuration. Each provider
falls back to the other when available. Paid worker identities belong in private
environment configuration. See `backend/README.md` for setup.

## MCP Server

`mcp/` is a standalone [MCP](https://modelcontextprotocol.io) server
(`supoclip-mcp`, Python/FastMCP, stdio) that exposes SupoClip to MCP clients
(Claude Desktop/Code, Cursor, …). It is a thin client over the REST API.

- **Default target:** the hosted API `https://api.supoclip.com`. Override with
  `SUPOCLIP_API_URL` for self-hosting (e.g. `http://localhost:8000`).
- **Auth:** a per-user API key in `SUPOCLIP_API_KEY` (see API keys above).
  Self-hosters may instead use `SUPOCLIP_USER_ID` (+ `SUPOCLIP_AUTH_SECRET` when
  signing is enforced).
- **Tools:** create/list/get/wait/cancel/resume/delete tasks, list/download/
  export clips, and public discovery (templates, transitions, fonts, B-roll).
- Run with `cd mcp && uv run supoclip-mcp`. Details in `mcp/README.md`.
