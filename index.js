// AdVance ClickUp → Dropbox Folder Automation
// Listens for a ClickUp webhook and creates a client folder in Dropbox

const express = require("express");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// These come from Railway's environment variables — never hardcode them here
const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;
const CLICKUP_API_TOKEN = process.env.CLICKUP_API_TOKEN;

// Fetches the full task record from ClickUp's API, including custom fields.
// ClickUp's automation webhook only sends basic task info, not custom field values,
// so we need this extra call to get "Company Name".
async function getClickUpTask(taskId) {
  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: { Authorization: CLICKUP_API_TOKEN },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`ClickUp task fetch failed: ${JSON.stringify(data)}`);
  }

  return data;
}

// Root path — lets you confirm the app is alive by visiting the Railway URL in a browser
app.get("/", (req, res) => {
  res.send("AdVance Dropbox folder automation is running.");
});

// Uses the refresh token to get a fresh short-lived access token from Dropbox.
// This runs automatically every time a folder needs to be created — no manual steps.
async function getAccessToken() {
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id: APP_KEY,
      client_secret: APP_SECRET,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Dropbox token refresh failed: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

// Creates a folder in Dropbox at the given path
async function createDropboxFolder(accessToken, path) {
  const response = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, autorename: false }),
  });

  const data = await response.json();

  if (!response.ok) {
    // If the folder already exists, Dropbox returns a specific error — treat that as OK, not a failure
    if (data.error_summary && data.error_summary.includes("path/conflict")) {
      console.log(`Folder already exists, skipping: ${path}`);
      return { alreadyExists: true, path };
    }
    throw new Error(`Dropbox folder creation failed: ${JSON.stringify(data)}`);
  }

  console.log(`Folder created: ${path}`);
  return data;
}

// Sanitizes a client/project name so it's safe to use as a folder name
function sanitizeFolderName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}

// Pulls a named custom field's value off a ClickUp task object.
// ClickUp sends custom_fields as an array of { name, value, ... } objects.
function getCustomFieldValue(task, fieldName) {
  const field = task?.custom_fields?.find(
    (f) => f.name?.toLowerCase() === fieldName.toLowerCase()
  );
  return field?.value ?? null;
}

// Main webhook endpoint — ClickUp will POST here when a task is created/updated
app.post("/clickup-webhook", async (req, res) => {
  try {
    // TEMPORARY DEBUG LINE — logs the full incoming payload so we can see its real shape.
    // Remove this once things are working, since it'll clutter the logs.
    console.log("Incoming payload:", JSON.stringify(req.body, null, 2));

    // The webhook payload only gives us basic info, including the task ID.
    // We use that ID to fetch the FULL task (with custom fields) from ClickUp's API.
    const taskId = req.body?.payload?.id;

    if (!taskId) {
      return res.status(400).json({ error: "No task ID found in webhook payload" });
    }

    const task = await getClickUpTask(taskId);
    const clientName = getCustomFieldValue(task, "Company Name");

    if (!clientName) {
      return res.status(400).json({
        error: "No 'Company Name' custom field value found on this task",
      });
    }

    const folderName = sanitizeFolderName(clientName);
    const accessToken = await getAccessToken();

    // Base path lives inside the shared "AdVance Creative Team Folder" > "Video Ads"
    const videoAdsPath = "/AdVance Creative Team Folder/Video Ads";

    // Per-client folder, named "[Company Name] Winners"
    const clientFolderPath = `${videoAdsPath}/${folderName} Winners`;

    // Shared folders that live directly under Video Ads (not per-client)
    const sharedFolders = ["For Review", "Approved"];

    await createDropboxFolder(accessToken, clientFolderPath);
    for (const shared of sharedFolders) {
      await createDropboxFolder(accessToken, `${videoAdsPath}/${shared}`);
    }

    res.json({
      success: true,
      clientFolder: clientFolderPath,
      sharedFolders: sharedFolders.map((s) => `${videoAdsPath}/${s}`),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // TEMPORARY DIAGNOSTIC — checks the refresh token for hidden characters
  // (quotes, spaces, line breaks) without printing the whole secret.
  if (REFRESH_TOKEN) {
    console.log("REFRESH_TOKEN length:", REFRESH_TOKEN.length);
    console.log("REFRESH_TOKEN first 6 chars:", JSON.stringify(REFRESH_TOKEN.slice(0, 6)));
    console.log("REFRESH_TOKEN last 6 chars:", JSON.stringify(REFRESH_TOKEN.slice(-6)));
  } else {
    console.log("REFRESH_TOKEN is missing entirely!");
  }
});
