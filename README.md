# AdVance ClickUp → Dropbox Folder Automation

Automatically creates a client folder (with subfolders) in Dropbox whenever a ClickUp webhook fires.

## What this needs to run

Three environment variables, set in Railway (never written into the code):

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

## Setup steps

### 1. Push this code to GitHub
- Create a new empty repository on GitHub (no README/license — just empty)
- From this folder, run:
  ```
  git init
  git add .
  git commit -m "Initial commit"
  git branch -M main
  git remote add origin YOUR_GITHUB_REPO_URL
  git push -u origin main
  ```

### 2. Deploy to Railway
- In Railway, click "New Project" → "Deploy from GitHub repo" → select this repo
- Go to the service's **Variables** tab and add the three Dropbox variables above
- Railway will auto-deploy. Once live, it gives you a public URL like `https://your-app.up.railway.app`

### 3. Point ClickUp at it
- In ClickUp, set up a webhook (via their API, or an integration) pointing to:
  `https://your-app.up.railway.app/clickup-webhook`
- Trigger it on whatever event you want (task created, status changed to WON, etc.)

## Adjusting folder structure

Open `index.js` and edit the `subfolders` array to change what subfolders get created under each client folder. Edit `basePath` if you want a different top-level location than `/Clients/`.

## Adjusting what triggers a folder name

Right now the code reads `req.body.task.name` as the client/project name. If ClickUp sends the client name in a custom field instead, that line in `index.js` needs to be updated to match — the exact payload shape depends on how the webhook is configured.
