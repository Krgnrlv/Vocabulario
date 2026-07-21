# Vocabulario

A personal Spanish vocabulary trainer — with groups, flashcards, photos, and quizzes. Data is stored in the cloud (Supabase), so your dictionary is available on any device once you're logged in.

## Features

- **Words**: add a Spanish word, its translation, an example sentence, and a photo. Search and filter by group.
- **Groups**: organize words by topic, with a custom color and cover photo for each group.
- **Practice modes**: two ways to test yourself —
  - **Flashcards** — flip animation, self-rate "I know it / I don't" with swipe buttons on either side.
  - **Multiple choice** — pick the correct translation from several options.
  - Direction: Spanish → translation, translation → Spanish, or photo → word.
- **Learning progress**: each word has its own confidence indicator (dots on the card) that grows with correct answers and resets on a mistake.
- **Share a group**: download a single group as a file and send it on (e.g. a teacher sharing it with students).
- **Export / import the whole dictionary**: JSON backup. On import, learning progress is always reset to zero — everyone starts fresh.
- **Accounts**: sign up and log in with email/password; data is tied to your account and available on any device.

## How it's built

This is a single HTML file (`vocabulario.html`) with no build step or dependencies — it just opens in a browser. Data is stored in **Supabase** (Postgres + built-in auth), and the site talks to it directly via `fetch`.

The database schema lives in `vocabulario_schema_v3.sql`.

## Setting up your own copy

### 1. Create a Supabase project

1. Sign up at [supabase.com](https://supabase.com) (free).
2. **New Project** → set a database password → wait for it to provision (~2 minutes).

### 2. Run the database schema

In the project dashboard: **SQL Editor** → paste the contents of `vocabulario_schema_v3.sql` → **Run**.

The script is safe to re-run — it drops old tables and triggers before recreating them.

### 3. Copy your project keys

**Project Settings → API (or API Keys)**:
- **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
- The **anon public** key (or **Publishable key**, if your project has the newer key system)

Paste both values into `vocabulario.html`, near the top of the `<script>` block:

```js
const SUPABASE_URL = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'your-key-here';
```

### 4. (Recommended) Disable email confirmation

By default, Supabase requires confirming your email after signup. For personal use it's usually easier to turn this off:
**Authentication → Sign In / Providers → Email** → disable **Confirm email**.

## Publishing the site

**Important:** the site can't be opened directly inside a Claude chat — the artifact sandbox blocks outbound requests to external servers, so logging in will fail with `Failed to fetch`. It needs to be hosted as a real site:

1. Create a GitHub repository.
2. Upload `vocabulario.html` to it.
3. **Settings → Pages** → Source: **Deploy from a branch**, branch `main`, folder `/ (root)` → **Save**.
4. After 1–2 minutes the site will be live at:
   ```
   https://your-username.github.io/repository-name/vocabulario.html
   ```

Any other static host works too (Netlify, Vercel, etc.) — the file is self-contained and needs no special build configuration.

## Usage

1. Open the site via its link → sign up (email + password).
2. **"Слова" (Words)** tab — add words, optionally sorting them into groups and attaching photos right away.
3. **"Группы" (Groups)** tab — create topic groups, change their color/cover, share a single group.
4. **"Проверка" (Practice)** tab — pick a set of words, a direction and a mode, start training.
5. The ⚙️ icon in the header — back up your dictionary (download/upload JSON) and sign out.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to fetch` on login | The site is open directly inside a Claude chat | Open it via the GitHub Pages link (or another host), not inside the chat |
| "Check your email" after signup | Email confirmation is enabled in Supabase | Disable it under Authentication → Providers → Email, or confirm the email |
| `trigger "on_auth_user_created" already exists` when running the SQL | The schema was already run before | Use `vocabulario_schema_v3.sql` — it cleans up old objects before recreating them |
| Words aren't saving / disappear | The site is open as a local file with no network access, or the schema hasn't been run | Make sure the schema is applied and the site is opened through a host, not `file://` |

## Limitations

- The `SUPABASE_ANON_KEY` is public by design — that's normal for Supabase. Actual data protection comes from Row Level Security policies in the database, not from keeping the key secret.
- Photos are stored directly in the database as text (base64), with no separate file storage — fine for personal use, but not meant for hundreds of high-resolution images.
- Password recovery via email isn't set up separately — you get whatever Supabase's standard auth flow provides out of the box.
