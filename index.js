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

// Fetches the root namespace ID for the team space, so folder operations
// target the shared team space instead of the personal namespace by default.
async function getTeamRootNamespaceId(accessToken) {
  const response = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Dropbox get_current_account returned non-JSON (status ${response.status}): ${rawText}`);
  }

  if (!response.ok) {
    throw new Error(`Dropbox get_current_account failed: ${JSON.stringify(data)}`);
  }

  const rootNamespaceId = data?.root_info?.root_namespace_id;
  if (!rootNamespaceId) {
    throw new Error(`No root_namespace_id found in account info: ${JSON.stringify(data)}`);
  }

  return rootNamespaceId;
}

// Creates a folder in Dropbox at the given path
async function createDropboxFolder(accessToken, path, rootNamespaceId) {
  const response = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // This header tells Dropbox to resolve the path against the team space root
      // instead of the calling user's personal namespace.
      "Dropbox-API-Path-Root": JSON.stringify({ ".tag": "root", root: rootNamespaceId }),
    },
    body: JSON.stringify({ path, autorename: false }),
  });

  // Read the raw text first — Dropbox sometimes returns plain-text errors
  // (not JSON) for malformed requests, and trying to JSON.parse those crashes.
  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    // Not JSON — surface the raw text directly so we can see what Dropbox actually said
    throw new Error(`Dropbox returned a non-JSON response (status ${response.status}): ${rawText}`);
  }

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
    const rootNamespaceId = await getTeamRootNamespaceId(accessToken);

    // Structure:
    // /AdVance Creative Team Folder/{Company Name}/
    //   Video Ads/
    //     {Company Name} Winners/
    //     Approved/
    //     For Review/
    const clientBasePath = `/AdVance Creative Team Folder/${folderName}`;
    const videoAdsPath = `${clientBasePath}/Video Ads`;
    const winnersPath = `${videoAdsPath}/${folderName} Winners`;
    const sharedFolders = ["Approved", "For Review"];

    await createDropboxFolder(accessToken, clientBasePath, rootNamespaceId);
    await createDropboxFolder(accessToken, videoAdsPath, rootNamespaceId);
    await createDropboxFolder(accessToken, winnersPath, rootNamespaceId);
    for (const shared of sharedFolders) {
      await createDropboxFolder(accessToken, `${videoAdsPath}/${shared}`, rootNamespaceId);
    }

    res.json({
      success: true,
      clientFolder: clientBasePath,
      winnersFolder: winnersPath,
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
