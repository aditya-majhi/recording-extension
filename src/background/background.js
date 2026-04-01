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

// ── Deduplicate helper: for input steps, keep only the last per selector ──
function deduplicateInputSteps(allSteps) {
  // Find the last index of each input step by selector key
  const lastInputIdx = new Map();
  allSteps.forEach((step, index) => {
    if (step.type !== "input") return;
    const key = step.selector?.css || step.selector?.xpath;
    if (key) lastInputIdx.set(key, index);
  });
  return allSteps.filter((step, index) => {
    if (step.type !== "input") return true;
    const key = step.selector?.css || step.selector?.xpath;
    if (!key) return true;
    return lastInputIdx.get(key) === index;
  });
}

// ── Deduplicate helper: merge variables by id ──
function mergeVariables(existing, incoming) {
  const existingVarIds = new Set(existing.map((v) => v.id));
  const newUniqueVars = incoming.filter((v) => !existingVarIds.has(v.id));
  if (newUniqueVars.length) {
    return [...existing, ...newUniqueVars];
  }
  return existing;
}

// ── Badge Helpers ──
function setBadge(text, color = "#FF0000") {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "Automation Recorder" });
}

function sendToTab(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        /* tab might be closed */
      }
    });
  } catch {
    /* ignore */
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
  chrome.contextMenus.create({
    id: "var-button",
    title: "Save as Button Variable",
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
    return;
  }
  if (info.menuItemId === "var-button") {
    chrome.tabs.sendMessage(tab.id, {
      type: "CREATE_VARIABLE",
      kind: "button",
    });
    return;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  ACTION CLICK
// ══════════════════════════════════════════════════════════════════════════════
chrome.action.onClicked.addListener(async (tab) => {
  console.log("[BG] 🖱 Action icon clicked, tab:", tab.id);

  if (!currentRecording) {
    console.log("[BG] no currentRecording, ignoring");
    return;
  }
  if (currentRecording.videoController) {
    console.log("[BG] video already running, ignoring");
    return;
  }

  if (currentRecording.pendingVideoForTab) {
    const tabId = currentRecording.pendingVideoForTab;

    try {
      const streamId = await getStreamId(tabId);
      const controller = await startCapture(streamId);

      currentRecording.videoController = controller;
      currentRecording.videoReady = true;
      currentRecording.pendingVideoForTab = null;

      setBadge("REC", "#CC0000");
      chrome.action.setTitle({ title: "Recording in progress (with video)" });
      sendToTab(tabId, { type: "VIDEO_STARTED" });
    } catch (err) {
      console.error("[BG] ❌ Video start failed:", err.message);

      if (currentRecording) {
        currentRecording.videoController = null;
        currentRecording.videoReady = true;
        currentRecording.pendingVideoForTab = null;
      }

      setBadge("REC", "#FF8800");
      chrome.action.setTitle({ title: "Recording in progress (no video)" });
      sendToTab(currentRecording?.tabId || tab.id, { type: "VIDEO_SKIPPED" });
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CORE RECORDING FLOW
// ══════════════════════════════════════════════════════════════════════════════
async function startRecordingFlow(tabId, testCaseId) {
  console.log(
    "[BG] ====== startRecordingFlow ======",
    "tabId:",
    tabId,
    "testCaseId:",
    testCaseId,
  );

  if (currentRecording) {
    console.log("[BG] startRecordingFlow — ALREADY_RECORDING, returning error");
    return { success: false, error: "ALREADY_RECORDING" };
  }

  currentRecording = {
    tabId,
    testCaseId: testCaseId || null,
    steps: [],
    variables: [],
    videoController: null,
    videoReady: false,
    pendingVideoForTab: tabId,
    finalFlushReceived: false,
  };
  console.log(
    "[BG] currentRecording created:",
    JSON.stringify({ tabId, testCaseId: testCaseId || null }),
  );

  try {
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

  setBadge("▶", "#FF6600");
  chrome.action.setTitle({
    title: "Click to enable video recording for this tab",
  });

  try {
    const streamId = await getStreamId(tabId);
    console.log("[BG] getStreamId succeeded:", streamId);
    const controller = await startCapture(streamId);
    currentRecording.videoController = controller;
    currentRecording.videoReady = true;
    currentRecording.pendingVideoForTab = null;
    setBadge("REC", "#CC0000");
    chrome.action.setTitle({ title: "Recording in progress (with video)" });
    sendToTab(tabId, { type: "VIDEO_STARTED" });
    console.log("[BG] Video capture started successfully");
  } catch (err) {
    console.log(
      "[BG] Direct getStreamId failed (expected from external):",
      err.message,
    );
  }

  console.log(
    "[BG] startRecordingFlow done — videoPending:",
    !!currentRecording?.pendingVideoForTab,
  );
  return {
    success: true,
    videoPending: !!currentRecording?.pendingVideoForTab,
  };
}

async function stopRecordingFlow() {
  console.log("[BG] ====== stopRecordingFlow ======");
  console.log("[BG] currentRecording exists:", !!currentRecording);

  if (!currentRecording) {
    return {
      success: false,
      error: "NO_ACTIVE_RECORDING",
      steps: [],
      variables: [],
      videoBlob: null,
    };
  }

  console.log(
    "[BG] currentRecording state — steps:",
    currentRecording.steps.length,
    "vars:",
    currentRecording.variables.length,
    "finalFlushReceived:",
    currentRecording.finalFlushReceived,
  );

  const { tabId, videoController } = currentRecording;

  if (tabId != null) {
    try {
      console.log("[BG] sending STOP_RECORDING to tab:", tabId);
      await chrome.tabs.sendMessage(tabId, { type: "STOP_RECORDING" });
      console.log("[BG] Content acknowledged STOP_RECORDING");
    } catch (err) {
      console.warn("[BG] Error stopping content:", err.message);
    }
  }

  const maxFlushWait = 3000;
  const poll = 100;
  let waitedFlush = 0;
  console.log("[BG] waiting for final flush (max", maxFlushWait, "ms)...");
  while (
    currentRecording &&
    !currentRecording.finalFlushReceived &&
    waitedFlush < maxFlushWait
  ) {
    await new Promise((r) => setTimeout(r, poll));
    waitedFlush += poll;
  }

  if (currentRecording?.finalFlushReceived) {
    console.log("[BG] ✅ Final flush received after", waitedFlush, "ms");
  } else {
    console.warn("[BG] ⚠ Final flush NOT received within", maxFlushWait, "ms");
  }

  console.log(
    "[BG] currentRecording steps after flush wait:",
    currentRecording?.steps?.length || 0,
  );

  let videoBlob = null;
  if (videoController) {
    try {
      videoBlob = await stopCapture(videoController);
      console.log("[BG] Video blob:", videoBlob?.size, "bytes");
    } catch (err) {
      console.warn("[BG] stopCapture failed:", err.message);
    }
  }

  const finalSteps = [...(currentRecording?.steps || [])];
  const finalVars = [...(currentRecording?.variables || [])];

  clearBadge();
  currentRecording = null;

  console.log(
    "[BG] ====== stopRecordingFlow DONE — steps:",
    finalSteps.length,
    "vars:",
    finalVars.length,
    "======",
  );
  return { success: true, steps: finalSteps, variables: finalVars, videoBlob };
}

// ══════════════════════════════════════════════════════════════════════════════
//  INTERNAL MESSAGES
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  console.log(
    "[BG] onMessage received:",
    type,
    "from tab:",
    sender.tab?.id || "(no tab)",
  );

  if (type === "RECORDER_FLUSH") {
    if (currentRecording) {
      const {
        steps: newSteps = [],
        variables: newVars = [],
        isFinal = false,
      } = message;

      // ALWAYS replace steps — content script sends the full compressed array each time
      if (Array.isArray(newSteps) && newSteps.length) {
        currentRecording.steps = deduplicateInputSteps(newSteps);
        console.log(
          "[BG] RECORDER_FLUSH — replaced steps, total:",
          currentRecording.steps.length,
          "isFinal:",
          isFinal,
        );
      }

      // Merge variables by id (never duplicate)
      if (Array.isArray(newVars) && newVars.length) {
        currentRecording.variables = mergeVariables(
          currentRecording.variables,
          newVars,
        );
      }

      if (isFinal) {
        currentRecording.finalFlushReceived = true;
        console.log(
          "[BG] ✅ finalFlushReceived = true, steps:",
          currentRecording.steps.length,
        );
      }
    }
    sendResponse({ success: true });
    return;
  }

  if (type === "GET_RECORDING_STATE") {
    const state = {
      success: true,
      isRecording: !!currentRecording,
      stepCount: currentRecording?.steps?.length ?? 0,
      tabId: currentRecording?.tabId ?? null,
      hasVideo: !!currentRecording?.videoController,
      videoPending: !!currentRecording?.pendingVideoForTab,
    };
    console.log("[BG] GET_RECORDING_STATE response:", JSON.stringify(state));
    sendResponse(state);
    return;
  }

  if (type === "SKIP_VIDEO") {
    console.log("[BG] SKIP_VIDEO received");
    if (currentRecording) {
      currentRecording.pendingVideoForTab = null;
      currentRecording.videoReady = true;
      currentRecording.videoController = null;
      setBadge("REC", "#FF8800");
      chrome.action.setTitle({ title: "Recording in progress (no video)" });
    }
    sendResponse({ success: true });
    return;
  }

  if (type === "DEV_START_RECORDING") {
    const tabId = sender.tab?.id;
    console.log("[BG] DEV_START_RECORDING from tab:", tabId);
    if (tabId == null) {
      console.error("[BG] DEV_START_RECORDING — NO TAB ID!");
      sendResponse({ success: false, error: "NO_TAB_ID" });
      return;
    }
    startRecordingFlow(tabId, null).then((res) => {
      console.log("[BG] startRecordingFlow result:", JSON.stringify(res));
      sendResponse(res);
    });
    return true;
  }

  if (type === "DEV_STOP_RECORDING") {
    console.log("[BG] DEV_STOP_RECORDING received");
    console.log("[BG] currentRecording exists:", !!currentRecording);
    if (currentRecording) {
      console.log(
        "[BG] currentRecording state:",
        JSON.stringify({
          steps: currentRecording.steps.length,
          vars: currentRecording.variables.length,
          finalFlushReceived: currentRecording.finalFlushReceived,
        }),
      );
    }

    if (!currentRecording) {
      console.error("[BG] DEV_STOP — NO currentRecording!");
      sendResponse({ success: false, error: "NO_ACTIVE_RECORDING" });
      return;
    }

    (async () => {
      if (!currentRecording.finalFlushReceived) {
        console.log("[BG] DEV_STOP — waiting for final flush...");
        const maxWait = 2000;
        let waited = 0;
        while (
          currentRecording &&
          !currentRecording.finalFlushReceived &&
          waited < maxWait
        ) {
          await new Promise((r) => setTimeout(r, 50));
          waited += 50;
        }
        console.log(
          "[BG] DEV_STOP — flush wait done, waited:",
          waited,
          "ms, received:",
          currentRecording?.finalFlushReceived,
        );
      } else {
        console.log("[BG] DEV_STOP — finalFlushReceived already true");
      }

      let videoBlob = null;
      if (currentRecording?.videoController) {
        try {
          videoBlob = await stopCapture(currentRecording.videoController);
          console.log("[BG] DEV_STOP — video blob:", videoBlob?.size, "bytes");
        } catch (err) {
          console.warn("[BG] DEV_STOP — stopCapture failed:", err.message);
        }
      }

      const finalSteps = [...(currentRecording?.steps || [])];
      const finalVars = [...(currentRecording?.variables || [])];

      console.log(
        "[BG] DEV_STOP — final steps:",
        finalSteps.length,
        "vars:",
        finalVars.length,
      );
      if (finalSteps.length > 0) {
        console.log(
          "[BG] DEV_STOP — step details:",
          JSON.stringify(
            finalSteps.map((s) => ({
              type: s.type,
              css: s.selector?.css,
              value: s.value,
            })),
          ),
        );
      }

      clearBadge();
      currentRecording = null;

      const response = {
        success: true,
        stepsCount: finalSteps.length,
        variablesCount: finalVars.length,
        steps: finalSteps,
        variables: finalVars,
        hasVideo: !!videoBlob,
      };
      console.log(
        "[BG] DEV_STOP — sending response:",
        JSON.stringify({
          ...response,
          steps: `[${response.steps.length} items]`,
        }),
      );
      sendResponse(response);
    })();
    return true;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  EXTERNAL MESSAGES
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {
    console.log(
      "[BG] onMessageExternal received:",
      message?.action,
      "from:",
      sender.origin || sender.url,
    );

    if (!isValidExternalSender(sender)) {
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
          const tab = await chrome.tabs.create({ url, active: true });
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
          await new Promise((r) => setTimeout(r, 500));
          const result = await startRecordingFlow(tab.id, testCaseId);
          sendResponse(result);
        } catch (err) {
          sendResponse({
            success: false,
            error: err.message || "FAILED_TO_OPEN_TAB",
          });
        }
      })();
      return true;
    }

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
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (currentRecording?.tabId === tabId) {
    console.warn("[BG] Recorded tab closed, auto-stopping");
    await stopRecordingFlow();
  }
});

console.log("[BG] ✅ Background script loaded");
