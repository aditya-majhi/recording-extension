import {
  startRecording,
  stopRecording,
  handleCreateVariable,
} from "./recorder.js";
import {
  showVideoPromptBar,
  showRecordingBar,
  removeBar,
} from "./recordingBar.js";

const DEV_BUTTON_ID = "__automation-recorder-toggle";
const RECORDER_UI_ATTR = "data-automation-recorder-ui";
let devRecording = false;

// ── On load, check if we should already be recording ──
function checkAndResumeRecording() {
  console.log("[INDEX] checkAndResumeRecording()");
  chrome.runtime.sendMessage({ type: "GET_RECORDING_STATE" }, (res) => {
    if (chrome.runtime.lastError) {
      console.log(
        "[INDEX] checkAndResumeRecording error:",
        chrome.runtime.lastError.message,
      );
      return;
    }
    console.log(
      "[INDEX] checkAndResumeRecording response:",
      JSON.stringify(res),
    );
    if (!res?.isRecording) return;

    startRecording();

    if (res.hasVideo) {
      showRecordingBar("Recording in progress (with video)");
    } else if (res.videoPending) {
      showVideoPromptBar();
    } else {
      showRecordingBar("Recording in progress (no video)");
    }
  });
}

// ── Message Listener (background → content) ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg?.type;
  console.log("[INDEX] onMessage received:", type);

  if (type === "START_RECORDING") {
    console.log("[INDEX] handling START_RECORDING from background");
    startRecording();
    showVideoPromptBar();
    sendResponse({ success: true });
    return;
  }

  if (type === "STOP_RECORDING") {
    console.log("[INDEX] handling STOP_RECORDING from background");
    removeBar();
    stopRecording().then((result) => {
      console.log(
        "[INDEX] STOP_RECORDING → stopRecording() resolved — steps:",
        result.steps.length,
      );
      sendResponse({ success: true });
    });
    return true; // async response
  }

  if (type === "CREATE_VARIABLE") {
    handleCreateVariable(msg.kind);
    sendResponse({ success: true });
    return;
  }

  if (type === "VIDEO_STARTED") {
    console.log("[INDEX] VIDEO_STARTED received");
    showRecordingBar("Recording in progress (with video)");
    sendResponse({ success: true });
    return;
  }

  if (type === "VIDEO_SKIPPED") {
    console.log("[INDEX] VIDEO_SKIPPED received");
    showRecordingBar("Recording in progress (no video)");
    sendResponse({ success: true });
    return;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
console.log("[INDEX] Content script loaded, readyState:", document.readyState);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    console.log("[INDEX] DOMContentLoaded fired");
    checkAndResumeRecording();
  });
} else {
  console.log("[INDEX] Document already ready");
  checkAndResumeRecording();
}
