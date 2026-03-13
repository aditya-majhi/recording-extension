const OFFSCREEN_URL = "offscreen.html";

// recordingId → { resolve, reject }
const pendingResults = new Map();

// ── Listen for results from offscreen ──
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "OFFSCREEN_CAPTURE_RESULT") return;

  console.log("[Video] Received OFFSCREEN_CAPTURE_RESULT:", {
    recordingId: message.recordingId,
    hasVideoBase64: !!message.videoBase64,
    base64Length: message.videoBase64?.length ?? 0,
  });

  const { recordingId, videoBase64, mimeType } = message;
  const entry = pendingResults.get(recordingId);
  if (!entry) {
    console.warn("[Video] No pending entry for recordingId:", recordingId);
    return;
  }
  pendingResults.delete(recordingId);

  if (!videoBase64) {
    console.warn("[Video] videoBase64 is null/empty, resolving null");
    entry.resolve(null);
    return;
  }

  try {
    const blob = dataUrlToBlob(videoBase64, mimeType || "video/webm");
    console.log("[Video] Decoded blob, size:", blob.size);
    entry.resolve(blob);
  } catch (err) {
    console.warn("[Video] Failed to decode blob:", err);
    entry.resolve(null);
  }
});

function dataUrlToBlob(dataUrl, mimeType) {
  const parts = dataUrl.split(",");
  if (parts.length < 2) throw new Error("Invalid data URL");
  const binary = atob(parts[1]);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// ── Offscreen document helpers ──
async function ensureOffscreenDocument() {
  console.log("[Video] ensureOffscreenDocument called");

  if (!chrome.offscreen) {
    console.error("[Video] chrome.offscreen API is NOT available!");
    throw new Error("Offscreen API not available");
  }

  if (chrome.offscreen.hasDocument) {
    const exists = await chrome.offscreen.hasDocument();
    console.log("[Video] Offscreen document already exists:", exists);
    if (exists) return;
  }

  console.log("[Video] Creating offscreen document...");
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Record tab as video for test automation",
    });
    console.log("[Video] Offscreen document created successfully");
  } catch (err) {
    console.error("[Video] Failed to create offscreen document:", err);
    throw err;
  }
}

/**
 * Get a media stream ID for a tab.
 * MUST be called from a user-gesture context (action.onClicked, contextMenus.onClicked).
 * @param {number} tabId
 * @returns {Promise<string>}
 */
export function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    console.log("[Video] getStreamId called for tabId:", tabId);
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      console.log("[Video] getMediaStreamId callback fired");
      console.log(
        "[Video] lastError:",
        chrome.runtime.lastError?.message ?? "none",
      );
      console.log(
        "[Video] streamId:",
        streamId ? streamId.slice(0, 30) + "..." : "null",
      );

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!streamId) {
        reject(new Error("getMediaStreamId returned null"));
        return;
      }
      console.log("[Video] getStreamId SUCCESS, length:", streamId.length);
      resolve(streamId);
    });
  });
}

/**
 * Start recording using an already-obtained streamId.
 * @param {string} streamId — from getStreamId()
 * @returns {Promise<{ recordingId: string }>}
 */
export async function startCapture(streamId) {
  console.log("[Video] ====== startCapture called ======");

  await ensureOffscreenDocument();

  const recordingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log("[Video] Generated recordingId:", recordingId);

  console.log("[Video] Sending OFFSCREEN_START_CAPTURE with streamId...");

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "OFFSCREEN_START_CAPTURE",
        streamId,
        recordingId,
      },
      (response) => {
        console.log("[Video] OFFSCREEN_START_CAPTURE response:", response);
        console.log(
          "[Video] lastError:",
          chrome.runtime.lastError?.message ?? "none",
        );

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "OFFSCREEN_START_FAILED"));
          return;
        }
        console.log(
          "[Video] ====== startCapture SUCCESS, recordingId:",
          recordingId,
          "======",
        );
        resolve({ recordingId });
      },
    );
  });
}

/**
 * Stop video capture and return the recorded Blob (or null).
 * @param {{ recordingId: string }} controller
 * @returns {Promise<Blob|null>}
 */
export async function stopCapture(controller) {
  const { recordingId } = controller;
  console.log(
    "[Video] ====== stopCapture called, recordingId:",
    recordingId,
    "======",
  );

  await ensureOffscreenDocument();

  const blobPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const entry = pendingResults.get(recordingId);
      if (entry) {
        pendingResults.delete(recordingId);
        console.warn("[Video] Timed out (15s) waiting for video blob");
        resolve(null);
      }
    }, 15000);

    pendingResults.set(recordingId, {
      resolve: (blob) => {
        clearTimeout(timeout);
        resolve(blob);
      },
      reject: (err) => {
        clearTimeout(timeout);
        console.warn("[Video] stopCapture reject:", err);
        resolve(null);
      },
    });
  });

  console.log("[Video] Sending OFFSCREEN_STOP_CAPTURE...");

  chrome.runtime.sendMessage(
    { type: "OFFSCREEN_STOP_CAPTURE", recordingId },
    (response) => {
      console.log("[Video] OFFSCREEN_STOP_CAPTURE response:", response);
      console.log(
        "[Video] lastError:",
        chrome.runtime.lastError?.message ?? "none",
      );

      if (chrome.runtime.lastError || !response?.success) {
        console.warn(
          "[Video] Failed to stop capture:",
          chrome.runtime.lastError?.message || response?.error,
        );
        const entry = pendingResults.get(recordingId);
        if (entry) {
          entry.resolve(null);
          pendingResults.delete(recordingId);
        }
      }
    },
  );

  return blobPromise;
}
