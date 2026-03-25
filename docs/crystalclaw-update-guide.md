# CrystalClaw Update Guide

How to update CrystalClaw from upstream OpenClaw.

## Architecture

CrystalClaw = upstream OpenClaw + 5 minimal source patches + external plugins + Crystal Chat frontend.

```
openclaw/openclaw (upstream)
  └─ crystalclaw-main (5 source patches on top)
      ├─ crystalclaw-plugins/ (auto-pair, crystal-chat channel, moltmobile, etc.)
      └─ crystal-chat/ (standalone web frontend, builds to separate JS/CSS)
```

## Prerequisites

| Component | Location | Remote |
|-----------|----------|--------|
| CrystalClaw | `Q:\Projects\crystalclaw` | origin → openclaw/openclaw |
| Plugins | `Q:\Projects\crystalclaw-plugins` | — |
| Crystal Chat | `Q:\Projects\crystal-chat` | — |

Branch: `crystalclaw-main`

## Active Source Patches (5 as of 2026-03-24)

These are the only source modifications that must survive a rebase:

| Patch | Files | Purpose |
|-------|-------|---------|
| **crystal-13: advanced-tools** | `anthropic-advanced-tools.ts`, `extra-params.ts`, `run/attempt.ts`, `system-prompt.ts`, `zod-schema.agent-runtime.ts`, UI files | Anthropic code_execution + tool search/deferred loading + programmatic calling |
| **crystal-14: branding** | `extra-params.ts` | `X-Title: "CrystalClaw"` on OpenRouter headers |
| **prompt-cache-split** | `extra-params.ts`, `system-prompt.ts` | Stable/volatile Anthropic system prompt caching |
| **embedding-retry** | `manager-embedding-ops.ts` | Rate limit handling (6 attempts, 2s base, 65s max, 800ms inter-batch) |
| **client-ids** | `client-info.ts` | Registers `crystal-chat` + `moltmobile` as valid client IDs/modes (4 lines) |

### Files to watch during rebase
```
src/agents/pi-embedded-runner/extra-params.ts        ← 3 patches touch this
src/agents/pi-embedded-runner/anthropic-advanced-tools.ts  ← crystal-13 only
src/agents/pi-embedded-runner/run/attempt.ts         ← crystal-13
src/agents/system-prompt.ts                          ← 2 patches
src/memory/manager-embedding-ops.ts                  ← embedding-retry
src/gateway/protocol/client-info.ts                  ← client-ids
src/config/zod-schema.agent-runtime.ts               ← crystal-13
```

## External Components (no source patches needed)

| Component | How it works |
|-----------|-------------|
| **auto-pair plugin** | `POST /auto-pair` — auto-pairs crystal-chat/moltmobile devices with operator scopes |
| **Nexus API proxy** | `/nexus-api/*` prefix route in auto-pair plugin — proxies to localhost:4580 |
| **Crystal Chat frontend** | Separate Vite build → external JS/CSS files → deployed to control-ui assets |
| **Channel plugins** | crystal-chat + moltmobile registered as channels via plugin API |

## Full Update Flow

### 1. Backup current state
```powershell
cd Q:\Projects\crystalclaw
git branch backup-pre-update-$(Get-Date -Format 'yyyyMMdd') crystalclaw-main
```

### 2. Fetch upstream & check what changed
```powershell
git fetch origin

# See new commits
git log --oneline crystalclaw-main..origin/main

# Check if our patched files were touched
git log --oneline crystalclaw-main..origin/main --name-only -- `
  src/agents/pi-embedded-runner/extra-params.ts `
  src/agents/pi-embedded-runner/anthropic-advanced-tools.ts `
  src/agents/pi-embedded-runner/run/attempt.ts `
  src/agents/system-prompt.ts `
  src/memory/manager-embedding-ops.ts `
  src/gateway/protocol/client-info.ts `
  src/config/zod-schema.agent-runtime.ts
```

If no output → clean rebase expected. If files listed → expect conflicts.

### 3. Stash & rebase
```powershell
git stash push -u -m "pre-update stash"

# Prefer tagged releases
git rebase v2026.X.XX

# Or main if no new tag
git rebase origin/main
```

### 4. Handle conflicts

**Old dropped patches:** If crystal-01 through 12, 16, 18, 20-22 conflict → `git rebase --skip`

**Kept patches conflicting:**
- Keep our additions, accept upstream structural changes
- `pnpm-lock.yaml` conflicts: keep our patched `@mariozechner/pi-ai` entry with `patch_hash`
- `timer.ts` conflicts: crystal-13 touched cron timer — drop the exec-cron block if it appears

### 5. Restore stash & install deps
```powershell
git stash pop
pnpm install
```

### 6. Build CrystalClaw
```powershell
npx tsdown                              # TypeScript compile
cd ui && npx vite build && cd ..        # UI build (creates dist/control-ui/)
```

### 7. Build & deploy Crystal Chat
```powershell
cd Q:\Projects\crystal-chat
npx vite build                          # Builds to dist/ with separate JS/CSS

# Copy to CrystalClaw assets
$dest = "Q:\Projects\crystalclaw\crystalclaw-assets\control-ui"
Copy-Item dist\index.html "$dest\crystal-chat.html" -Force
Copy-Item dist\assets\crystal-chat.js "$dest\assets\crystal-chat.js" -Force
Copy-Item dist\assets\style.css "$dest\assets\crystal-chat-style.css" -Force

# Fix CSS link (Vite outputs style.css, we rename to crystal-chat-style.css)
(Get-Content "$dest\crystal-chat.html") -replace 'href="./assets/style.css"', 'href="./assets/crystal-chat-style.css"' | Set-Content "$dest\crystal-chat.html"
```

### 8. Post-build deploy
```powershell
cd Q:\Projects\crystalclaw
node scripts/crystalclaw-post-build.mjs   # Copies crystalclaw-assets → dist/control-ui/
```

⚠️ **Order matters:** UI build (step 6) creates `dist/control-ui/`. Post-build (step 8) overlays Crystal Chat into it. If you skip the UI build, post-build will fail ("No dist/control-ui found").

### 9. Install plugins
```powershell
cd Q:\Projects\crystalclaw-plugins
node install.mjs --plugins --assets
```

### 10. Post-build fixes
```powershell
cd Q:\Projects\crystalclaw
openclaw doctor --fix
node scripts/_typed-tools-crystalclaw.cjs
```

### 11. Restart gateway
```powershell
openclaw gateway restart
```

### 12. Verify
- Open `http://localhost:4556/crystal-chat.html` — should connect
- Check logs: `openclaw logs` — look for `[auto-pair]` and `webchat connected`
- No CSP errors in browser console (except browser extension noise like stealth.js)

## One-liner (after rebase is clean)

```powershell
cd Q:\Projects\crystalclaw; pnpm install; npx tsdown; cd ui; npx vite build; cd ..; cd Q:\Projects\crystal-chat; npx vite build; $d="Q:\Projects\crystalclaw\crystalclaw-assets\control-ui"; cp dist\index.html "$d\crystal-chat.html"; cp dist\assets\crystal-chat.js "$d\assets\crystal-chat.js"; cp dist\assets\style.css "$d\assets\crystal-chat-style.css"; (gc "$d\crystal-chat.html") -replace 'href="./assets/style.css"','href="./assets/crystal-chat-style.css"' | sc "$d\crystal-chat.html"; cd Q:\Projects\crystalclaw; node scripts/crystalclaw-post-build.mjs; cd Q:\Projects\crystalclaw-plugins; node install.mjs --plugins --assets; cd Q:\Projects\crystalclaw; openclaw doctor --fix; node scripts/_typed-tools-crystalclaw.cjs; openclaw gateway restart
```

## Rollback

```powershell
git rebase --abort                              # If rebase in progress
git reset --hard backup-pre-update-YYYYMMDD     # Restore from backup branch
openclaw gateway restart
```

## History

| Date | Change |
|------|--------|
| **2026-03-24** | FR-043: Major cleanup. 22 patches → 5. Created auto-pair plugin (FR-046), Nexus proxy (FR-047), Crystal Chat external build. |
| | Backup branches: `crystalclaw-pre-cleanup`, `upgrade-start-20260324-*` |
| | Open FRs: FR-045 (file attachments), FR-048 (cron-exec), FR-049 (dynamic Nexus detection) |
