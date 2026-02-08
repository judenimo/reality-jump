# Reality Jump — Photo to Platformer Game

A mobile browser game that converts real-world photos into playable platformer levels using AI vision. Take a photo of your surroundings and watch it transform into a game level where detected objects become platforms, pickups, and enemies.

Built with React 19, TypeScript, Phaser 3, Vite, OpenAI GPT-4o Vision, and Supabase.

## How It Works

```
Splash screen → "Take a Photo" or "Play Shared Level"
    ↓
Photo is compressed and uploaded to the Express backend
    ↓
GPT-4o Vision detects objects in the image (labels, bounding boxes)
    ↓
Deterministic level builder arranges detections into a zigzag
staircase of platforms, pickups, enemies, and an exit
    ↓
Phaser 3 renders a playable platformer level with the photo as background
    ↓
Player reaches the exit → Win! → Optionally share the level to Supabase
```

---

## Prerequisites

- **Node.js** ≥ 18 (LTS recommended)
- **npm** ≥ 9
- An **OpenAI API key** with GPT-4o access (see setup below)
- *(Optional)* A **Supabase** project for level sharing (see setup below)

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd reality-jump
npm install
```

### 2. Create the `.env` file

Copy the template and fill in your keys:

```bash
cp .env.example .env
```

Or create `.env` manually in the project root:

```dotenv
# Required — OpenAI
OPENAI_API_KEY=sk-proj-YOUR_KEY_HERE

# Optional — Supabase (level sharing)
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY_HERE
```

> **`.env` is git-ignored.** Never commit API keys.

---

### 3. Get an OpenAI API key

The backend uses **GPT-4o** (via the OpenAI Node SDK) to detect objects in uploaded photos. You need an API key with access to the `gpt-4o` model.

1. Go to [https://platform.openai.com/signup](https://platform.openai.com/signup) and create an account (or sign in).
2. Navigate to **API keys**: [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys).
3. Click **"Create new secret key"**.
4. Give it a name (e.g. `reality-jump`) and click **Create**.
5. **Copy the key immediately** — it starts with `sk-proj-...` and is only shown once.
6. Paste it into your `.env` file:
   ```dotenv
   OPENAI_API_KEY=sk-proj-YOUR_KEY_HERE
   ```

**Billing:** OpenAI requires a payment method. Each photo analysis costs roughly $0.01–0.03 (image tokens). Add credit at [https://platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing).

---

### 4. Set up Supabase (optional — for level sharing)

Supabase provides the database and image storage for the "Share Level" feature. If you skip this, the game is fully playable — you just won't be able to share or browse levels.

#### 4a. Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) and sign up / sign in.
2. Click **"New Project"**.
3. Choose an organisation, give the project a name (e.g. `reality-jump`), set a database password, and pick a region close to you.
4. Click **"Create new project"** and wait for it to provision (~1 minute).

#### 4b. Get your API keys

1. In your Supabase project dashboard, go to **Settings → API** (left sidebar → ⚙️ Settings → API).
2. Copy these two values into your `.env`:

| Dashboard field | `.env` variable |
| --- | --- |
| **Project URL** | `VITE_SUPABASE_URL` |
| **anon / public** key (under "Project API keys") | `VITE_SUPABASE_ANON_KEY` |

```dotenv
VITE_SUPABASE_URL=https://abcdefghijklmnop.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### 4c. Create the `levels` table

1. In the dashboard, go to **SQL Editor** (left sidebar).
2. Click **"New query"** and paste the following SQL:

```sql
CREATE TABLE IF NOT EXISTS levels (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    player_name text        NOT NULL,
    level_name  text        NOT NULL,
    scene_data  jsonb       NOT NULL,
    image_path  text,
    score       integer     NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Allow anyone to read levels (public browse)
ALTER TABLE levels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read"  ON levels FOR SELECT USING (true);
CREATE POLICY "Public insert" ON levels FOR INSERT WITH CHECK (true);
```

3. Click **"Run"**. You should see `Success. No rows returned`.

#### 4d. Create the `level-images` storage bucket

1. Go to **Storage** (left sidebar).
2. Click **"New bucket"**.
3. Name it exactly: `level-images`
4. Toggle **"Public bucket"** to **ON**.
5. Click **"Create bucket"**.
6. Click on the newly created `level-images` bucket.
7. Go to the **Policies** tab (within the bucket page).
8. Add two policies:

**Policy 1 — Public read:**
- Click **"New policy"** → **"For full customization"**.
- Policy name: `Public read`
- Allowed operation: **SELECT**
- Target roles: leave blank (defaults to all)
- USING expression: `true`
- Click **"Review"** → **"Save policy"**.

**Policy 2 — Public upload:**
- Click **"New policy"** → **"For full customization"**.
- Policy name: `Public upload`
- Allowed operation: **INSERT**
- Target roles: leave blank
- WITH CHECK expression: `true`
- Click **"Review"** → **"Save policy"**.

That's it — Supabase is ready.

---

### 5. Run the app

```bash
# Start both the Express backend (port 3001) and Vite frontend (port 8080)
npm run dev:all
```

Open in your browser: [http://localhost:8080](http://localhost:8080)

**On mobile:** Check the terminal output for the `Network:` URL (e.g. `http://192.168.1.x:8080`) and open that on your phone. Both devices must be on the same Wi-Fi network.

---

## Available Commands

| Command | Description |
| --- | --- |
| `npm install` | Install project dependencies |
| `npm run dev` | Launch frontend only (Vite, port 8080) |
| `npm run dev:all` | Launch frontend + backend together |
| `npm run server` | Launch backend only (Express, port 3001) |
| `npm run build` | Create production build |
| `npm run test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |

---

## Game Flow

1. **Splash** — "Take a Photo" to create a level from your camera, or "Play Shared Level" to browse community levels
2. **Capture** — Take/upload a photo; it's compressed (max 1024px, JPEG 0.75) and sent to the backend
3. **AI Detection** — GPT-4o Vision detects objects in the photo (labels, bounding boxes, categories)
4. **Level Build** — Deterministic builder creates a zigzag staircase level from the detections
5. **Preview** — Detected objects overlaid on the photo with debug toggle
6. **Play** — Phaser renders the level; collect coins, avoid enemies, reach the exit flag
7. **Win/Lose** — Score screen with options to replay, retake photo, or share the level

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend** | React 19, TypeScript 5.7, Vite 6.3 |
| **Game Engine** | Phaser 3.90 (Arcade Physics) |
| **AI Vision** | OpenAI GPT-4o (object detection) |
| **Level Builder** | Deterministic zigzag staircase algorithm |
| **Database** | Supabase (PostgreSQL + Storage) |
| **Validation** | Zod |
| **Backend** | Express 4, Multer (multipart uploads) |
| **Styling** | Vanilla CSS with glassmorphism |
| **Icons** | Lucide React (UI), Canvas-drawn (game sprites) |

---

## Project Structure

### UI Layer (React)

| Path | Description |
| --- | --- |
| `src/App.tsx` | Root component — splash / capture / browse / play routing |
| `src/ui/SplashScreen.tsx` | Home screen with "Take a Photo" and "Play Shared Level" buttons |
| `src/ui/CaptureAndUploadScreen.tsx` | Orchestrates capture → upload → preview flow |
| `src/ui/PlayScreen.tsx` | Gameplay screen with score, health, share-on-win |
| `src/ui/WinOverlay.tsx` | Victory overlay with share form |
| `src/ui/BrowseLevelsScreen.tsx` | Browse/search shared levels from Supabase |
| `src/ui/MobileControls.tsx` | Touch-friendly left/right/jump buttons |

### Game Engine (Phaser 3)

| Path | Description |
| --- | --- |
| `src/game/scenes/GameScene.ts` | Main gameplay — physics, player, platforms, pickups, enemies, exit |
| `src/game/factories/` | Factories for Player, Platform, Pickup, Exit, Enemy sprites |
| `src/game/assets/IconTextureFactory.ts` | Runtime Canvas-based sprite generation (no external assets) |
| `src/game/physics/PhysicsConfig.ts` | Adaptive physics (jump height, speed, sizes) |

### Backend

| Path | Description |
| --- | --- |
| `server/index.ts` | Express server (port 3001), CORS, health check |
| `server/routes/scene.ts` | `POST /api/scene` — sends photo to GPT-4o, builds level |
| `server/levelBuilder.ts` | Deterministic level builder (zigzag staircase algorithm) |

### Services

| Path | Description |
| --- | --- |
| `src/services/ai_proxy_service.ts` | Frontend API client for `/api/scene` |
| `src/services/supabase.ts` | Supabase client — share, fetch, browse levels |

---

## Key Architecture Decisions

### Two-Stage Pipeline: AI Detection → Deterministic Builder

The photo is sent to GPT-4o which only performs **object detection** (labels, bounding boxes, categories). It makes zero gameplay decisions. A separate deterministic `levelBuilder.ts` then arranges detected objects into a playable zigzag staircase layout with guaranteed reachability.

### Runtime Icon Generation

Game sprites are generated at runtime using Canvas 2D API. No external image assets needed — `IconTextureFactory` draws Lucide icon paths programmatically.

### Normalized Coordinates

All positions use normalized coordinates (0.0–1.0). The game world matches the photo's aspect ratio and `coords.ts` converts to world pixels.

### React ↔ Phaser Bridge

An `EventBus` bridges React and Phaser. Mobile controls write to a shared `InputState` that Phaser reads each frame. Game events flow from Phaser to React.

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| `OPENAI_API_KEY` error on startup | Make sure `.env` exists in the project root with a valid key |
| AI returns errors / timeouts | Check your OpenAI billing — you need credit on your account |
| Level sharing doesn't work | Supabase keys are optional; check `.env` has both `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` |
| Can't type in share form inputs | Update to latest code — `disableGlobalCapture()` fix in GameScene.ts |
| Mobile can't connect | Ensure phone and laptop are on the same Wi-Fi; use the `Network:` URL from terminal |
| Port 8080 in use | Kill the other process or change the port in `vite/config.dev.mjs` |

---

## License

MIT
