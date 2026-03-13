"use strict";

console.log("[Offscreen] offscreen.js loaded");

const MIME_TYPE = "video/webm;codecs=vp8";

let mediaRecorder = null;
let chunks = [];
let activeRecordingId = null;
let activeStream = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log("[Offscreen] Received message:", message?.type);

  if (!message || !message.type) return;

  // ── START: receive streamId, open stream via getUserMedia, start MediaRecorder ──
  if (message.type === "OFFSCREEN_START_CAPTURE") {
    const { streamId, recordingId } = message;

    console.log(
      "[Offscreen] START_CAPTURE request, recordingId:",
      recordingId,
      "streamId:",
      streamId ? streamId.slice(0, 20) + "..." : "null",
    );

    if (mediaRecorder) {
      console.warn("[Offscreen] Already recording, rejecting");
      sendResponse({ success: false, error: "ALREADY_RECORDING" });
      return;
    }

    if (!streamId) {
      console.error("[Offscreen] No streamId provided");
      sendResponse({ success: false, error: "NO_STREAM_ID" });
      return;
    }

    activeRecordingId = recordingId;
    chunks = [];

    console.log("[Offscreen] Calling getUserMedia with chromeMediaSourceId...");

    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
      })
      .then((stream) => {
        console.log("[Offscreen] getUserMedia SUCCESS");
        console.log(
          "[Offscreen] Stream tracks:",
          stream.getTracks().map((t) => ({
            kind: t.kind,
            label: t.label,
            readyState: t.readyState,
          })),
        );

        activeStream = stream;

        // Handle track ending (user stops sharing or tab closes)
        stream.getVideoTracks()[0].addEventListener("ended", () => {
          console.log("[Offscreen] Video track ended by user/system");
          if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
          }
        });

        // Check MIME type support
        const mimeSupported = MediaRecorder.isTypeSupported(MIME_TYPE);
        console.log("[Offscreen] MIME supported:", mimeSupported, MIME_TYPE);

        const recorderOptions = mimeSupported ? { mimeType: MIME_TYPE } : {};

        mediaRecorder = new MediaRecorder(stream, recorderOptions);
        console.log(
          "[Offscreen] MediaRecorder created, state:",
          mediaRecorder.state,
        );

        mediaRecorder.ondataavailable = (e) => {
          console.log("[Offscreen] ondataavailable, size:", e.data?.size ?? 0);
          if (e.data && e.data.size > 0) {
            chunks.push(e.data);
          }
        };

        mediaRecorder.onstop = () => {
          console.log("[Offscreen] onstop fired, chunks:", chunks.length);

          const blob = new Blob(chunks, { type: "video/webm" });
          const rId = activeRecordingId;

          console.log("[Offscreen] Final blob size:", blob.size);

          // Stop all tracks
          if (activeStream) {
            activeStream.getTracks().forEach((t) => t.stop());
            activeStream = null;
          }

          mediaRecorder = null;
          chunks = [];
          activeRecordingId = null;

          if (blob.size === 0) {
            console.warn("[Offscreen] Blob is empty, sending null");
            chrome.runtime.sendMessage({
              type: "OFFSCREEN_CAPTURE_RESULT",
              recordingId: rId,
              videoBase64: null,
            });
            return;
          }

          console.log("[Offscreen] Converting blob to base64...");
          const reader = new FileReader();
          reader.onloadend = () => {
            console.log(
              "[Offscreen] Base64 ready, length:",
              reader.result?.length ?? 0,
            );
            chrome.runtime.sendMessage({
              type: "OFFSCREEN_CAPTURE_RESULT",
              recordingId: rId,
              videoBase64: reader.result,
              mimeType: "video/webm",
            });
          };
          reader.onerror = () => {
            console.error("[Offscreen] FileReader error");
            chrome.runtime.sendMessage({
              type: "OFFSCREEN_CAPTURE_RESULT",
              recordingId: rId,
              videoBase64: null,
            });
          };
          reader.readAsDataURL(blob);
        };

        mediaRecorder.onerror = (e) => {
          console.error("[Offscreen] MediaRecorder error:", e);
        };

        mediaRecorder.start(1000);
        console.log(
          "[Offscreen] MediaRecorder started, state:",
          mediaRecorder.state,
        );
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error(
          "[Offscreen] getUserMedia FAILED:",
          err.name,
          err.message,
        );
        activeRecordingId = null;
        sendResponse({ success: false, error: err.message });
      });

    return true; // async sendResponse
  }

  // ── STOP ──
  if (message.type === "OFFSCREEN_STOP_CAPTURE") {
    console.log("[Offscreen] STOP_CAPTURE request:", {
      hasRecorder: !!mediaRecorder,
      recorderState: mediaRecorder?.state ?? "N/A",
    });

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      console.warn("[Offscreen] No active capture to stop");
      sendResponse({ success: false, error: "NO_ACTIVE_CAPTURE" });
      return;
    }

    console.log("[Offscreen] Calling mediaRecorder.stop()...");
    mediaRecorder.stop();
    sendResponse({ success: true });
    return;
  }
});
