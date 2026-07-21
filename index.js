// AdVance ClickUp → Dropbox Folder Automation
// Listens for a ClickUp webhook and creates a client folder in Dropbox

const express = require("express");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Handles form-encoded bodies too, in case GHL sends that instead of JSON

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

// New route: receives the GHL "Recap Call Booked" webhook and forwards a clean message to Slack.
// This exists because GHL's built-in webhook action doesn't reliably send Slack the format it expects.
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Converts a naive Eastern-time string (e.g. "2026-07-24T15:00:00") to Pacific time.
// GHL's account is set to Eastern, but the team operates in Pacific — ET is always
// 3 hours ahead of PT (both follow the same US DST schedule), so a flat offset works.
function convertEasternToPacific(easternTimeStr) {
  const [datePart, timePart] = easternTimeStr.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);

  const asUTC = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  asUTC.setUTCHours(asUTC.getUTCHours() - 3);

  return asUTC;
}

app.post("/ghl-recap-call", async (req, res) => {
  try {
    // TEMPORARY DEBUG LINE — logs exactly what GHL sends, so we can see its real shape.
    console.log("Incoming GHL payload:", JSON.stringify(req.body, null, 2));

    const contactName = req.body?.full_name || req.body?.first_name || "Someone";
    const rawStartTime = req.body?.calendar?.startTime; // e.g. "2026-07-24T15:00:00" (Eastern, naive)

    let message;
    if (rawStartTime) {
      const pacificDate = convertEasternToPacific(rawStartTime);
      const formattedTime = pacificDate.toLocaleString("en-US", {
        timeZone: "UTC", // prevents double-shifting — we already converted manually
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      message = `<!channel> Hi team! New recap call booked with ${contactName} at ${formattedTime} PT`;
    } else {
      // Fallback in case the calendar object isn't present for some reason
      const ghlMessage = req.body?.customData?.text || req.body?.text || "New recap call booked (details unavailable)";
      message = `<!channel> ${ghlMessage}`;
    }

    const slackResponse = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });

    const slackText = await slackResponse.text();

    if (!slackResponse.ok) {
      throw new Error(`Slack post failed (status ${slackResponse.status}): ${slackText}`);
    }

    console.log("Posted to Slack successfully:", message);
    res.json({ success: true, message });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
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
    //   Assets/
    const clientBasePath = `/AdVance Creative Team Folder/${folderName}`;
    const videoAdsPath = `${clientBasePath}/Video Ads`;
    const assetsPath = `${clientBasePath}/Assets`;
    const winnersPath = `${videoAdsPath}/${folderName} Winners`;
    const sharedFolders = ["Approved", "For Review"];

    await createDropboxFolder(accessToken, clientBasePath, rootNamespaceId);
    await createDropboxFolder(accessToken, videoAdsPath, rootNamespaceId);
    await createDropboxFolder(accessToken, assetsPath, rootNamespaceId);
    await createDropboxFolder(accessToken, winnersPath, rootNamespaceId);
    for (const shared of sharedFolders) {
      await createDropboxFolder(accessToken, `${videoAdsPath}/${shared}`, rootNamespaceId);
    }

    res.json({
      success: true,
      clientFolder: clientBasePath,
      videoAdsFolder: videoAdsPath,
      assetsFolder: assetsPath,
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