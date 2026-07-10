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

    // Pulls the client name from the "Company Name" custom field on the task.
    // ClickUp's automation webhook nests the task data under "payload", not "task".
    const task = req.body?.payload;
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
});
