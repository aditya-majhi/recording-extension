import axios from "axios";

const BACKEND_BASE_URL = "http://localhost:3000";

// ── Axios Instance ──
const api = axios.create({
  baseURL: BACKEND_BASE_URL,
});

// ── Token Helpers (stored in chrome.storage.local) ──
export async function saveAuthToken(token) {
  console.log("[API] Saving auth token, length:", token?.length);
  await chrome.storage.local.set({ authToken: token });
}

export async function getAuthToken() {
  const result = await chrome.storage.local.get("authToken");
  return result.authToken || null;
}

export async function clearAuthToken() {
  await chrome.storage.local.remove("authToken");
}

// ── Request Interceptor: attach token + correct Content-Type ──
api.interceptors.request.use(
  async (config) => {
    // Attach auth token
    const token = await getAuthToken();
    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Only set Content-Type to JSON if body is NOT FormData
    // (axios auto-sets multipart boundary for FormData)
    if (config.data instanceof FormData) {
      // Let axios/browser set the correct Content-Type with boundary
      delete config.headers["Content-Type"];
    } else {
      config.headers["Content-Type"] = "application/json";
    }

    return config;
  },
  (error) => Promise.reject(error),
);

// ── Response Interceptor: normalize errors ──
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      await clearAuthToken();
      throw new Error("SESSION_EXPIRED");
    }
    const message =
      error.response?.data?.message ||
      error.message ||
      "An unexpected error occurred";
    throw new Error(message);
  },
);

// ─────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────
export async function login({ email, password }) {
  const res = await api.post("/auth/login", { email, password });
  const data = res.data.data;
  await saveAuthToken(data.token);
  return data;
}

export async function register({ name, email, password }) {
  const res = await api.post("/auth/register", { name, email, password });
  const data = res.data.data;
  await saveAuthToken(data.token);
  return data;
}

// ─────────────────────────────────────────────────────
// Recording API used by background.js
// ─────────────────────────────────────────────────────

/**
 * Upload raw video blob to backend as multipart/form-data.
 * Returns the video URL string or null if upload fails.
 */
export async function uploadVideo(videoBlob) {
  if (!videoBlob || !videoBlob.size) {
    console.log("[API] No video blob to upload, skipping");
    return null;
  }

  try {
    console.log("[API] Uploading video, size:", videoBlob.size);

    const formData = new FormData();
    formData.append("video", videoBlob, "recording.webm");

    const res = await api.post("/recordings/upload-video", formData);
    // interceptor handles Content-Type for FormData automatically

    const videoUrl = res.data.data.videoUrl;
    console.log("[API] Video uploaded, URL:", videoUrl);
    return videoUrl;
  } catch (err) {
    console.warn("[API] Video upload failed:", err.message || err);
    return null;
  }
}

/**
 * Upload a completed recording (steps + optional video + variables) to backend.
 */
export async function uploadRecording({
  testCaseId,
  steps,
  videoBlob = null,
  variables = [],
}) {
  if (!testCaseId) throw new Error("testCaseId is required");
  if (!Array.isArray(steps)) throw new Error("steps must be an array");
  if (!Array.isArray(variables)) throw new Error("variables must be an array");

  // 1) Upload video first (if present), get videoUrl
  let videoUrl = null;
  if (videoBlob && videoBlob.size > 0) {
    videoUrl = await uploadVideo(videoBlob);
  }

  console.log("[API] Creating recording:", {
    testCaseId,
    stepsCount: steps.length,
    variablesCount: variables.length,
    videoUrl,
  });

  // 2) Create recording with steps + variables + optional videoUrl
  const body = {
    testCaseId,
    steps,
    variables,
  };

  // Only include videoUrl if we actually have one
  if (videoUrl) {
    body.videoUrl = videoUrl;
  }

  const res = await api.post("/recordings", body);
  return res.data.data;
}

export async function getRecordings(testCaseId) {
  const res = await api.get(`/recordings/${testCaseId}`);
  return res.data.data;
}
