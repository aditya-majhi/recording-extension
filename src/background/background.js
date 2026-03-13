import {
  Actions,
  isValidExternalSender,
  isValidAction,
} from "../services/messageService.js";
import {
  getStreamId,
  startCapture,
  stopCapture,
} from "../services/videoService.js";
import { uploadRecording, saveAuthToken } from "../services/apiService.js";

// ── State ──
let currentRecording = null;

// ── Badge Helpers ──
function setBadge(text, color = "#FF0000") {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "Automation Recorder" });
}

// ── Safely send message to tab (ignore errors if tab is gone) ──
function sendToTab(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        // tab might be closed, ignore
      }
    });
  } catch {
    // ignore
  }
}

// ── Context Menus ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "start-recording",
    title: "Start Automation Recording",
    contexts: ["page"],
  });
  chrome.contextMenus.create({
    id: "var-input",
    title: "Save as Input Variable",
    contexts: ["all"],
  });
  chrome.contextMenus.create({
    id: "var-output",
    title: "Save as Output Variable",
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === "start-recording") {
    startRecordingFlow(tab.id, null);
    return;
  }
  if (info.menuItemId === "var-input") {
    chrome.tabs.sendMessage(tab.id, { type: "CREATE_VARIABLE", kind: "input" });
    return;
  }
  if (info.menuItemId === "var-output") {
    chrome.tabs.sendMessage(tab.id, {
      type: "CREATE_VARIABLE",
      kind: "output",
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ACTION CLICK — This is the user gesture that grants activeTab permission
//  When user clicks the extension icon, we can call getMediaStreamId
// ══════════════════════════════════════════════════════════════════════════════
chrome.action.onClicked.addListener(async (tab) => {
  console.log("[BG] 🖱 Action icon clicked, tab:", tab.id);

  // ── No recording active → ignore ──
  if (!currentRecording) {
    console.log("[BG] No recording in progress, ignoring action click");
    return;
  }

  // ── Video already recording → ignore ──
  if (currentRecording.videoController) {
    console.log("[BG] Video already recording, ignoring action click");
    return;
  }

  // ── Recording active, video pending → START VIDEO NOW ──
  if (currentRecording.pendingVideoForTab) {
    const tabId = currentRecording.pendingVideoForTab;
    console.log("[BG] Starting video capture via action click for tab:", tabId);

    try {
      // THIS WORKS because chrome.action.onClicked IS a real user gesture
      // → Chrome grants activeTab → getMediaStreamId succeeds
      const streamId = await getStreamId(tabId);
      console.log("[BG] getStreamId SUCCESS");

      const controller = await startCapture(streamId);
      console.log("[BG] startCapture SUCCESS:", controller);

      currentRecording.videoController = controller;
      currentRecording.videoReady = true;
      currentRecording.pendingVideoForTab = null;

      setBadge("REC", "#CC0000");
      chrome.action.setTitle({ title: "Recording in progress (with video)" });

      // Tell the content script to update the bar → red "Recording in progress"
      sendToTab(tabId, { type: "VIDEO_STARTED" });

      console.log(
        "[BG] ✅ Video capture started successfully via action click",
      );
    } catch (err) {
      console.error("[BG] ❌ Video start failed on action click:", err.message);

      // Video failed — continue recording without video
      if (currentRecording) {
        currentRecording.videoController = null;
        currentRecording.videoReady = true;
        currentRecording.pendingVideoForTab = null;
      }

      setBadge("REC", "#FF8800"); // orange = recording without video
      chrome.action.setTitle({ title: "Recording in progress (no video)" });

      sendToTab(currentRecording?.tabId || tab.id, { type: "VIDEO_SKIPPED" });
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CORE RECORDING FLOW
// ══════════════════════════════════════════════════════════════════════════════

async function startRecordingFlow(tabId, testCaseId) {
  console.log("[BG] ====== startRecordingFlow ======");
  console.log("[BG] tabId:", tabId, "testCaseId:", testCaseId);

  if (currentRecording) {
    console.warn("[BG] Already recording, rejecting");
    return { success: false, error: "ALREADY_RECORDING" };
  }

  currentRecording = {
    tabId,
    testCaseId: testCaseId || null,
    steps: [],
    variables: [],
    videoController: null,
    videoReady: false,
    pendingVideoForTab: tabId, // video waiting for user to click action icon
  };

  // 1) Start step recording via content script
  try {
    console.log("[BG] Sending START_RECORDING to content script...");
    await chrome.tabs.sendMessage(tabId, { type: "START_RECORDING" });
    console.log("[BG] Content script acknowledged START_RECORDING");
  } catch (err) {
    console.error("[BG] Content script not ready:", err.message);
    currentRecording = null;
    return {
      success: false,
      error: "CONTENT_SCRIPT_NOT_READY: " + err.message,
    };
  }

  // 2) Set badge to prompt user to click the extension icon
  setBadge("▶", "#FF6600"); // orange arrow
  chrome.action.setTitle({
    title: "Click to enable video recording for this tab",
  });

  // 3) Try to get streamId directly — this will work if triggered from context menu
  //    (context menu click IS a user gesture). It will FAIL if triggered from
  //    onMessageExternal (not a user gesture). That's expected.
  try {
    console.log(
      "[BG] Attempting direct getStreamId (may fail from external message)...",
    );
    const streamId = await getStreamId(tabId);
    console.log("[BG] Direct getStreamId succeeded!");

    const controller = await startCapture(streamId);
    console.log("[BG] Direct startCapture succeeded:", controller);

    currentRecording.videoController = controller;
    currentRecording.videoReady = true;
    currentRecording.pendingVideoForTab = null;

    setBadge("REC", "#CC0000");
    chrome.action.setTitle({ title: "Recording in progress (with video)" });

    // Tell content script to switch to "recording" bar
    sendToTab(tabId, { type: "VIDEO_STARTED" });

    console.log("[BG] ✅ Direct video start succeeded (context menu trigger)");
  } catch (err) {
    // This is expected when triggered from onMessageExternal
    console.log(
      "[BG] Direct getStreamId failed (expected from external):",
      err.message,
    );
    console.log("[BG] ⏳ Waiting for user to click extension icon...");
    // Content script already shows the prompt bar via START_RECORDING handler
  }

  console.log("[BG] ====== startRecordingFlow DONE ======");
  console.log("[BG] State:", {
    tabId: currentRecording?.tabId,
    videoController: !!currentRecording?.videoController,
    videoReady: currentRecording?.videoReady,
    pendingVideoForTab: currentRecording?.pendingVideoForTab,
  });

  return {
    success: true,
    videoPending: !!currentRecording?.pendingVideoForTab,
  };
}

async function stopRecordingFlow() {
  console.log("[BG] ====== stopRecordingFlow ======");

  if (!currentRecording) {
    return {
      success: false,
      error: "NO_ACTIVE_RECORDING",
      steps: [],
      variables: [],
      videoBlob: null,
    };
  }

  console.log("[BG] Current state:", {
    tabId: currentRecording.tabId,
    videoController: !!currentRecording.videoController,
    videoReady: currentRecording.videoReady,
    stepsCount: currentRecording.steps.length,
    varsCount: currentRecording.variables.length,
  });

  // Wait for video to be ready (max 5s) — covers race between action click and stop
  const maxWait = 5000;
  const pollInterval = 200;
  let waited = 0;
  while (currentRecording && !currentRecording.videoReady && waited < maxWait) {
    console.log("[BG] Waiting for videoReady... (waited:", waited, "ms)");
    await new Promise((r) => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  const { tabId, videoController, steps, variables } = currentRecording;
  let videoBlob = null;

  // 1) Stop content script
  try {
    if (tabId != null) {
      console.log("[BG] Sending STOP_RECORDING to content...");
      await chrome.tabs.sendMessage(tabId, { type: "STOP_RECORDING" });
      await new Promise((r) => setTimeout(r, 500)); // wait for final flush
      console.log("[BG] Content script stopped");
    }
  } catch (err) {
    console.warn("[BG] Error stopping content:", err.message);
  }

  // 2) Stop video capture
  if (videoController) {
    try {
      console.log("[BG] Stopping video capture...");
      videoBlob = await stopCapture(videoController);
      console.log(
        "[BG] Video blob:",
        videoBlob ? `${videoBlob.size} bytes` : "null",
      );
    } catch (err) {
      console.warn("[BG] stopCapture failed:", err.message);
      videoBlob = null;
    }
  } else {
    console.log(
      "[BG] No video controller — user didn't click extension icon or video failed",
    );
  }

  // Gather final steps/vars
  const finalSteps = currentRecording
    ? [...currentRecording.steps]
    : [...steps];
  const finalVars = currentRecording
    ? [...currentRecording.variables]
    : [...variables];

  // Clear state
  clearBadge();
  currentRecording = null;

  console.log("[BG] ====== stopRecordingFlow DONE ======");
  console.log(
    "[BG] Final: steps:",
    finalSteps.length,
    "vars:",
    finalVars.length,
    "hasVideo:",
    !!videoBlob,
  );

  return {
    success: true,
    steps: finalSteps,
    variables: finalVars,
    videoBlob,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  INTERNAL MESSAGES (content script → background)
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  // ── Flush steps/variables from content script ──
  if (type === "RECORDER_FLUSH") {
    if (currentRecording) {
      const { steps: newSteps = [], variables: newVars = [] } = message;
      if (Array.isArray(newSteps) && newSteps.length) {
        currentRecording.steps.push(...newSteps);
      }
      if (Array.isArray(newVars) && newVars.length) {
        currentRecording.variables.push(...newVars);
      }
    }
    sendResponse({ success: true });
    return;
  }

  // ── Get recording state ──
  if (type === "GET_RECORDING_STATE") {
    sendResponse({
      success: true,
      isRecording: !!currentRecording,
      stepCount: currentRecording?.steps?.length ?? 0,
      tabId: currentRecording?.tabId ?? null,
      hasVideo: !!currentRecording?.videoController,
      videoPending: !!currentRecording?.pendingVideoForTab,
    });
    return;
  }

  // ── Skip video (user clicked "Skip video" button in the bar) ──
  if (type === "SKIP_VIDEO") {
    console.log("[BG] User skipped video");
    if (currentRecording) {
      currentRecording.pendingVideoForTab = null;
      currentRecording.videoReady = true;
      currentRecording.videoController = null;

      setBadge("REC", "#FF8800"); // orange = recording without video
      chrome.action.setTitle({ title: "Recording in progress (no video)" });
    }
    sendResponse({ success: true });
    return;
  }

  // ── Dev: start recording from dev button ──
  if (type === "DEV_START_RECORDING") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ success: false, error: "NO_TAB_ID" });
      return;
    }
    startRecordingFlow(tabId, null).then(sendResponse);
    return true;
  }

  // ── Dev: stop recording from dev button ──
  if (type === "DEV_STOP_RECORDING") {
    stopRecordingFlow().then((result) => {
      sendResponse({
        success: result.success,
        stepsCount: result.steps.length,
        variablesCount: result.variables.length,
        hasVideo: !!result.videoBlob,
      });
    });
    return true;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  EXTERNAL MESSAGES (Web UI → extension)
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    if (!isValidExternalSender(sender)) {
      console.warn("[BG] Rejected external message from:", sender?.origin);
      sendResponse({ success: false, error: "UNAUTHORIZED_SENDER" });
      return;
    }

    const action = message?.action;

    if (action === "PING") {
      sendResponse({ success: true, installed: true });
      return;
    }

    if (!isValidAction(action)) {
      sendResponse({ success: false, error: "UNKNOWN_ACTION" });
      return;
    }

    // ── SET_TOKEN ──
    if (action === Actions.SET_TOKEN) {
      const token = message?.token;
      if (!token) {
        sendResponse({ success: false, error: "TOKEN_REQUIRED" });
        return;
      }
      (async () => {
        await saveAuthToken(token);
        sendResponse({ success: true });
      })();
      return true;
    }

    // ── GET_RECORDING_STATE ──
    if (action === Actions.GET_RECORDING_STATE) {
      sendResponse({
        success: true,
        isRecording: !!currentRecording,
        stepCount: currentRecording?.steps?.length ?? 0,
        hasVideo: !!currentRecording?.videoController,
        videoPending: !!currentRecording?.pendingVideoForTab,
      });
      return;
    }

    // ── START_RECORDING ──
    if (action === Actions.START_RECORDING) {
      const { url, testCaseId } = message;

      if (!url) {
        sendResponse({ success: false, error: "URL is required" });
        return;
      }
      if (!testCaseId) {
        sendResponse({ success: false, error: "testCaseId is required" });
        return;
      }

      (async () => {
        try {
          console.log(
            "[BG] External START_RECORDING: url:",
            url,
            "testCaseId:",
            testCaseId,
          );

          // Create new tab
          const tab = await chrome.tabs.create({ url, active: true });
          console.log("[BG] Tab created, id:", tab.id);

          // Wait for tab to fully load
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              reject(new Error("Tab load timed out after 30s"));
            }, 30000);

            function listener(tabId, info) {
              if (tabId === tab.id && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                clearTimeout(timeout);
                resolve();
              }
            }
            chrome.tabs.onUpdated.addListener(listener);
          });

          // Wait for content script to initialize
          console.log("[BG] Tab loaded, waiting for content script...");
          await new Promise((r) => setTimeout(r, 500));

          // Start recording (step recording starts immediately, video waits for action click)
          const result = await startRecordingFlow(tab.id, testCaseId);
          console.log("[BG] startRecordingFlow result:", result);
          sendResponse(result);
        } catch (err) {
          console.error("[BG] External START_RECORDING failed:", err);
          sendResponse({
            success: false,
            error: err.message || "FAILED_TO_OPEN_TAB",
          });
        }
      })();
      return true;
    }

    // ── STOP_RECORDING ──
    if (action === Actions.STOP_RECORDING) {
      const effectiveTestCaseId =
        message?.testCaseId || currentRecording?.testCaseId;

      if (!effectiveTestCaseId) {
        sendResponse({
          success: false,
          error: "testCaseId is required to save recording",
        });
        return;
      }

      (async () => {
        const result = await stopRecordingFlow();
        if (!result.success) {
          sendResponse(result);
          return;
        }

        try {
          const saved = await uploadRecording({
            testCaseId: effectiveTestCaseId,
            steps: result.steps,
            videoBlob: result.videoBlob,
            variables: result.variables,
          });

          sendResponse({
            success: true,
            steps: result.steps,
            variables: result.variables,
            hasVideo: !!result.videoBlob,
            recording: saved,
          });
        } catch (err) {
          console.error("[BG] Upload failed:", err);
          sendResponse({
            success: false,
            error: err.message || "UPLOAD_FAILED",
          });
        }
      })();
      return true;
    }
  },
);

// ══════════════════════════════════════════════════════════════════════════════
//  SAFETY: stop if the recorded tab is closed
// ══════════════════════════════════════════════════════════════════════════════
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (currentRecording?.tabId === tabId) {
    console.warn("[BG] Recorded tab closed, auto-stopping");
    await stopRecordingFlow();
  }
});
