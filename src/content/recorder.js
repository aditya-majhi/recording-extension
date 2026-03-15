let isRecording = false;
let steps = [];
let variables = [];
let listenersAttached = false;
let lastClick = { selector: null, time: 0 };
let lastRightClickedElement = null;
let flushIntervalId = null;

const pendingInputs = new Map();

const CLICK_DEBOUNCE_MS = 300;
const INPUT_DEBOUNCE_MS = 800;
const FLUSH_INTERVAL_MS = 2000;
const RECORDER_UI_ATTR = "data-automation-recorder-ui";

const CLICKABLE_INPUT_TYPES = new Set([
  "submit",
  "button",
  "reset",
  "checkbox",
  "radio",
]);

// ── Utils ─────────────────────────────────────────────────────────────────────

// ── Navigation flush: save steps before page unloads ──
function handleBeforeUnload() {
  if (!isRecording) return;
  console.log("[RECORDER][beforeunload] Page unloading — emergency flush");
  drainPendingInputs();
  // Use synchronous sendMessage (best-effort, may not always succeed)
  const compressed = compressSteps([...steps]);
  const vars = [...variables];
  if (!compressed.length && !vars.length) return;
  try {
    chrome.runtime.sendMessage({
      type: "RECORDER_FLUSH",
      steps: compressed,
      variables: vars,
      isFinal: false,
    });
  } catch {
    /* page is dying, nothing we can do */
  }
}

function isFromRecorderUi(target) {
  if (!target) return false;
  return (
    target.closest && target.closest(`[${RECORDER_UI_ATTR}="true"]`) !== null
  );
}

export function getLastRightClickedElement() {
  return lastRightClickedElement;
}

function nowTs() {
  return Date.now();
}

function getCssSelector(element) {
  if (!(element instanceof Element)) return null;
  const id = element.id;
  if (id && !/\d{3,}/.test(id)) {
    return `#${CSS.escape(id)}`;
  }
  if (element.classList.length) {
    const cls = Array.from(element.classList)
      .filter((c) => !/\d{3,}/.test(c))
      .map((c) => `.${CSS.escape(c)}`)
      .join("");
    if (cls) {
      return `${element.tagName.toLowerCase()}${cls}`;
    }
  }
  let path = "";
  let el = element;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    let selector = el.tagName.toLowerCase();
    if (el.id) {
      selector += `#${CSS.escape(el.id)}`;
      path = selector + (path ? " > " + path : "");
      break;
    } else {
      let sibling = el;
      let index = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === el.tagName) index++;
      }
      selector += `:nth-of-type(${index})`;
    }
    path = selector + (path ? " > " + path : "");
    el = el.parentElement;
  }
  return path || null;
}

function getXPath(element) {
  if (!(element instanceof Element)) return null;
  let segs = [];
  for (; element && element.nodeType === 1; element = element.parentNode) {
    if (element.hasAttribute("id")) {
      segs.unshift(
        `//*[@id="${element.getAttribute("id").replace(/"/g, '\\"')}"]`,
      );
      break;
    } else {
      let i = 1;
      let sib = element.previousSibling;
      for (; sib; sib = sib.previousSibling) {
        if (sib.nodeType === 1 && sib.nodeName === element.nodeName) i++;
      }
      segs.unshift(`${element.nodeName.toLowerCase()}[${i}]`);
    }
  }
  return segs.length ? "/" + segs.join("/") : null;
}

function buildSelectors(element) {
  return { css: getCssSelector(element), xpath: getXPath(element) };
}

function getElementValue(el) {
  if (!el) return null;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return el.checked;
    return el.value;
  }
  if (el.tagName === "SELECT") return el.value;
  return el.textContent?.trim() ?? null;
}

// ── Clickable ancestor resolution ─────────────────────────────────────────────
const MAX_ANCESTOR_WALK = 5;

function isInputElement(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !CLICKABLE_INPUT_TYPES.has(type);
  }
  if (el.getAttribute("contenteditable") === "true") return true;
  return false;
}

function resolveClickTarget(rawEl) {
  console.log(
    "[RECORDER][resolveClickTarget] rawEl:",
    rawEl.tagName,
    rawEl.id || rawEl.className || "(no id/class)",
  );

  if (isInputElement(rawEl)) {
    console.log(
      "[RECORDER][resolveClickTarget] → null (rawEl is input element)",
    );
    return null;
  }

  let el = rawEl;
  let walked = 0;
  while (el && el !== document.body && walked < MAX_ANCESTOR_WALK) {
    if (!(el instanceof Element)) {
      el = el.parentElement;
      walked++;
      continue;
    }
    const tag = el.tagName;
    console.log(
      "[RECORDER][resolveClickTarget] walk step",
      walked,
      "→ tag:",
      tag,
      "id:",
      el.id || "(none)",
      "role:",
      el.getAttribute("role") || "(none)",
    );

    if (tag === "BUTTON") {
      console.log("[RECORDER][resolveClickTarget] → BUTTON found");
      return el;
    }
    if (tag === "A" && (el.hasAttribute("href") || el.getAttribute("role"))) {
      console.log("[RECORDER][resolveClickTarget] → A found");
      return el;
    }
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (CLICKABLE_INPUT_TYPES.has(type)) {
        console.log(
          "[RECORDER][resolveClickTarget] → clickable INPUT found:",
          type,
        );
        return el;
      }
      console.log(
        "[RECORDER][resolveClickTarget] → null (text INPUT found while walking)",
      );
      return null;
    }
    if (tag === "TEXTAREA" || tag === "SELECT") {
      console.log(
        "[RECORDER][resolveClickTarget] → null (TEXTAREA/SELECT found while walking)",
      );
      return null;
    }
    if (tag === "LABEL") {
      const forAttr = el.getAttribute("for");
      if (forAttr && document.getElementById(forAttr)) {
        console.log("[RECORDER][resolveClickTarget] → null (LABEL for input)");
        return null;
      }
      if (el.querySelector("input, textarea, select")) {
        console.log(
          "[RECORDER][resolveClickTarget] → null (LABEL wraps input)",
        );
        return null;
      }
      console.log("[RECORDER][resolveClickTarget] → LABEL (standalone)");
      return el;
    }
    const role = el.getAttribute("role");
    if (
      role === "button" ||
      role === "link" ||
      role === "menuitem" ||
      role === "tab" ||
      role === "option" ||
      role === "checkbox" ||
      role === "radio"
    ) {
      console.log("[RECORDER][resolveClickTarget] → role:", role);
      return el;
    }
    if (el.hasAttribute("onclick")) {
      console.log("[RECORDER][resolveClickTarget] → onclick attr found");
      return el;
    }
    el = el.parentElement;
    walked++;
  }

  try {
    const style = window.getComputedStyle(rawEl);
    if (style.cursor === "pointer" || rawEl.hasAttribute("tabindex")) {
      console.log(
        "[RECORDER][resolveClickTarget] → rawEl (cursor:pointer or tabindex)",
      );
      return rawEl;
    }
  } catch {
    /* skip */
  }

  console.log(
    "[RECORDER][resolveClickTarget] → null (nothing clickable found)",
  );
  return null;
}

// ── Label / Name Discovery ────────────────────────────────────────────────────
function findLabelText(element) {
  const id = element.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const text = label?.textContent?.trim();
    if (text && text.length < 60) return text;
  }
  const wrappingLabel = element.closest("label");
  if (wrappingLabel) {
    const clone = wrappingLabel.cloneNode(true);
    clone
      .querySelectorAll("input, textarea, select")
      .forEach((i) => i.remove());
    const text = clone.textContent?.trim();
    if (text && text.length < 60) return text;
  }
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.length < 60) return ariaLabel;
  const ariaLabelledBy = element.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const labelEl = document.getElementById(ariaLabelledBy);
    const text = labelEl?.textContent?.trim();
    if (text && text.length < 60) return text;
  }
  const placeholder = element.getAttribute("placeholder");
  if (placeholder && placeholder.length < 60) return placeholder;
  const prev = element.previousElementSibling;
  if (prev) {
    const text = prev.textContent?.trim();
    if (text && text.length < 60) return text;
  }
  const parent = element.parentElement;
  if (parent) {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 1 && text.length < 60) return text;
      }
    }
  }
  const nameAttr = element.getAttribute("name");
  if (nameAttr && !/\d{3,}/.test(nameAttr)) return nameAttr;
  return null;
}

function generateVariableName(element, kind) {
  const label = findLabelText(element);
  const prefix = kind === "output" ? "out" : "in";
  if (label) {
    const cleaned = label
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .toLowerCase();
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length) {
      const camel =
        tokens[0] +
        tokens
          .slice(1)
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
          .join("");
      return `${prefix}_${camel}`.slice(0, 50);
    }
  }
  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute("type") || "";
  const fallback = type ? `${tag}_${type}` : tag;
  return `${prefix}_${fallback}`.slice(0, 50);
}

// ── Step & Variable Creation ──────────────────────────────────────────────────
function createStep(type, element, value = null) {
  if (!element) {
    console.log("[RECORDER][createStep] → null (no element)");
    return null;
  }
  const { css, xpath } = buildSelectors(element);
  if (!css && !xpath) {
    console.log(
      "[RECORDER][createStep] → null (no selectors for",
      element.tagName,
      ")",
    );
    return null;
  }
  const step = {
    type,
    selector: { css, xpath },
    value,
    targetTag: element.tagName.toLowerCase(),
    timestamp: nowTs(),
  };
  console.log(
    "[RECORDER][createStep] created:",
    type,
    css || xpath,
    "value:",
    value,
  );
  return step;
}

function getDirectTextContent(el) {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
  }
  const trimmed = text.trim().slice(0, 80);
  if (!trimmed && el.children.length === 0)
    return el.textContent?.trim().slice(0, 80) || null;
  return trimmed || null;
}

function createVariable(kind) {
  const el =
    lastRightClickedElement ||
    (document.activeElement instanceof Element ? document.activeElement : null);
  if (!el) return null;
  const { css, xpath } = buildSelectors(el);
  if (!css && !xpath) return null;
  const value = getElementValue(el);
  const name = generateVariableName(el, kind);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name,
    selector: { css, xpath },
    value,
    targetTag: el.tagName.toLowerCase(),
    createdAt: new Date().toISOString(),
  };
}

// ── Compress: keep only last input step per selector ─────────────────────────
function compressSteps(allSteps) {
  const lastInputIdx = new Map();
  allSteps.forEach((step, index) => {
    if (step.type !== "input") return;
    const key = step.selector?.css || step.selector?.xpath;
    if (key) lastInputIdx.set(key, index);
  });
  const result = allSteps.filter((step, index) => {
    if (step.type !== "input") return true;
    const key = step.selector?.css || step.selector?.xpath;
    if (!key) return true;
    return lastInputIdx.get(key) === index;
  });
  console.log(
    "[RECORDER][compressSteps] input:",
    allSteps.length,
    "→ output:",
    result.length,
  );
  return result;
}

// ── Flush helpers ─────────────────────────────────────────────────────────────
function sendFlush(isFinal) {
  const compressed = compressSteps([...steps]);
  const vars = [...variables];

  console.log(
    `[RECORDER][sendFlush] isFinal=${isFinal} steps=${compressed.length} vars=${vars.length}`,
  );
  console.log(
    "[RECORDER][sendFlush] step details:",
    JSON.stringify(
      compressed.map((s) => ({
        type: s.type,
        css: s.selector?.css,
        value: s.value,
      })),
    ),
  );

  if (!compressed.length && !vars.length) {
    console.log("[RECORDER][sendFlush] nothing to flush — skipping");
    return Promise.resolve();
  }

  const payload = {
    type: "RECORDER_FLUSH",
    steps: compressed,
    variables: vars,
    isFinal,
  };

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[RECORDER][sendFlush] chrome.runtime.lastError:",
            chrome.runtime.lastError.message,
          );
        } else {
          console.log(
            "[RECORDER][sendFlush] ack received:",
            JSON.stringify(res),
          );
        }
        resolve(res);
      });
    } catch (err) {
      console.error("[RECORDER][sendFlush] sendMessage threw:", err.message);
      resolve(null);
    }
  });
}

function periodicFlush() {
  console.log(
    "[RECORDER][periodicFlush] isRecording:",
    isRecording,
    "steps:",
    steps.length,
    "vars:",
    variables.length,
  );
  if (!isRecording) return;
  if (!steps.length && !variables.length) return;
  sendFlush(false);
}

// ── Drain pending debounce timers ─────────────────────────────────────────────
function drainPendingInputs() {
  console.log(
    "[RECORDER][drainPendingInputs] pending count:",
    pendingInputs.size,
  );
  for (const [key, { timeoutId, element }] of pendingInputs) {
    clearTimeout(timeoutId);
    if (element instanceof Element) {
      try {
        const value = getElementValue(element);
        const step = createStep("input", element, value);
        if (step) {
          steps.push(step);
          console.log(
            "[RECORDER][drainPendingInputs] drained step for:",
            key,
            "value:",
            value,
          );
        }
      } catch (err) {
        console.warn(
          "[RECORDER][drainPendingInputs] error draining:",
          key,
          err.message,
        );
      }
    } else {
      console.warn(
        "[RECORDER][drainPendingInputs] element not an Element for key:",
        key,
      );
    }
  }
  pendingInputs.clear();
}

// ── Event Handlers ────────────────────────────────────────────────────────────

function handleClick(event) {
  const raw = event.target;
  console.log(
    "[RECORDER][handleClick] FIRED — target:",
    raw?.tagName,
    raw?.id || raw?.className || "(no id/class)",
    "isRecording:",
    isRecording,
  );

  if (!isRecording) {
    console.log("[RECORDER][handleClick] → skipped (not recording)");
    return;
  }
  const rawEl = raw instanceof Element ? raw : raw?.parentElement;
  if (!rawEl) {
    console.log("[RECORDER][handleClick] → skipped (no rawEl)");
    return;
  }
  if (isFromRecorderUi(rawEl)) {
    console.log("[RECORDER][handleClick] → skipped (recorder UI)");
    return;
  }

  const target = resolveClickTarget(rawEl);
  if (!target) {
    console.log(
      "[RECORDER][handleClick] → skipped (resolveClickTarget returned null)",
    );
    return;
  }

  const { css } = buildSelectors(target);
  const now = nowTs();
  if (lastClick.selector === css && now - lastClick.time < CLICK_DEBOUNCE_MS) {
    console.log("[RECORDER][handleClick] → skipped (debounced)");
    return;
  }

  const value =
    target.getAttribute("aria-label") ||
    target.getAttribute("title") ||
    target.getAttribute("name") ||
    getDirectTextContent(target) ||
    null;

  const step = createStep("click", target, value);
  if (step) {
    steps.push(step);
    lastClick = { selector: css, time: now };
    console.log(
      "[RECORDER][handleClick] ✅ click step ADDED — css:",
      css,
      "value:",
      value,
      "total steps:",
      steps.length,
    );

    // If this click might cause navigation, flush immediately
    const mightNavigate =
      target.tagName === "A" ||
      (target.tagName === "BUTTON" &&
        (target.getAttribute("type") === "submit" ||
          !target.getAttribute("type"))) ||
      (target.tagName === "INPUT" && target.getAttribute("type") === "submit");

    if (mightNavigate) {
      console.log(
        "[RECORDER][handleClick] Navigation-likely click — draining + flushing now",
      );
      drainPendingInputs();
      sendFlush(false);
    }
  } else {
    console.log("[RECORDER][handleClick] → createStep returned null");
  }
}

function handleInput(event) {
  const target = event.target;
  console.log(
    "[RECORDER][handleInput] FIRED — target:",
    target?.tagName,
    target?.id || target?.className || "(no id/class)",
    "isRecording:",
    isRecording,
  );

  if (!(target instanceof Element)) {
    console.log("[RECORDER][handleInput] → skipped (not Element)");
    return;
  }
  if (!isRecording) {
    console.log("[RECORDER][handleInput] → skipped (not recording)");
    return;
  }
  if (isFromRecorderUi(target)) {
    console.log("[RECORDER][handleInput] → skipped (recorder UI)");
    return;
  }

  const tag = target.tagName;
  if (
    tag !== "INPUT" &&
    tag !== "TEXTAREA" &&
    tag !== "SELECT" &&
    target.getAttribute("contenteditable") !== "true"
  ) {
    console.log(
      "[RECORDER][handleInput] → skipped (not input/textarea/select/contenteditable, tag:",
      tag,
      ")",
    );
    return;
  }
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") || "text").toLowerCase();
    if (CLICKABLE_INPUT_TYPES.has(type)) {
      console.log(
        "[RECORDER][handleInput] → skipped (clickable input type:",
        type,
        ")",
      );
      return;
    }
  }

  const { css } = buildSelectors(target);
  const key = css || target;
  console.log("[RECORDER][handleInput] key:", key, "tag:", tag);

  const existing = pendingInputs.get(key);
  if (existing) {
    clearTimeout(existing.timeoutId);
    console.log("[RECORDER][handleInput] cleared previous debounce for:", key);
  }

  if (tag === "SELECT") {
    const value = getElementValue(target);
    const step = createStep("input", target, value);
    if (step) steps.push(step);
    pendingInputs.delete(key);
    console.log(
      "[RECORDER][handleInput] ✅ SELECT step ADDED — key:",
      key,
      "value:",
      value,
      "total steps:",
      steps.length,
    );
    return;
  }

  const timeoutId = setTimeout(() => {
    const value = getElementValue(target);
    const step = createStep("input", target, value);
    if (step) {
      steps.push(step);
      console.log(
        "[RECORDER][handleInput] ✅ debounced input step ADDED — key:",
        key,
        "value:",
        value,
        "total steps:",
        steps.length,
      );
    } else {
      console.log(
        "[RECORDER][handleInput] debounce fired but createStep returned null for:",
        key,
      );
    }
    pendingInputs.delete(key);
  }, INPUT_DEBOUNCE_MS);

  pendingInputs.set(key, { timeoutId, element: target });
  console.log(
    "[RECORDER][handleInput] debounce set for:",
    key,
    "timeout:",
    INPUT_DEBOUNCE_MS,
    "ms",
  );
}

function handleBlur(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!isRecording) return;
  if (isFromRecorderUi(target)) return;

  const tag = target.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
  if (tag === "INPUT") {
    const type = (target.getAttribute("type") || "text").toLowerCase();
    if (CLICKABLE_INPUT_TYPES.has(type)) return;
  }

  const { css } = buildSelectors(target);
  const key = css || target;
  const existing = pendingInputs.get(key);
  if (existing) {
    // A debounce was pending — drain it now with the final value
    clearTimeout(existing.timeoutId);
    pendingInputs.delete(key);
    const value = getElementValue(target);
    const step = createStep("input", target, value);
    if (step) {
      steps.push(step);
      console.log(
        "[RECORDER][handleBlur] ✅ blur step ADDED — key:",
        key,
        "value:",
        value,
        "total steps:",
        steps.length,
      );
    }
  }
  // If no pending debounce exists, do NOT push another step.
  // The debounce already fired and recorded the value.
}

function handleContextMenu(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    lastRightClickedElement = null;
    return;
  }
  if (isFromRecorderUi(target)) return;
  lastRightClickedElement = target;
}


function handleSubmit(event) {
  const form = event.target;
  console.log(
    "[RECORDER][handleSubmit] FIRED — target:",
    form?.tagName,
    form?.id || form?.className || "(no id/class)",
    "isRecording:",
    isRecording,
  );

  if (!isRecording) return;
  if (!(form instanceof HTMLFormElement)) return;
  if (isFromRecorderUi(form)) return;

  // Find the submit button that triggered this
  const submitBtn =
    form.querySelector('button[type="submit"]') ||
    form.querySelector('input[type="submit"]') ||
    form.querySelector("button:not([type])");

  const target = submitBtn || form;
  const { css } = buildSelectors(target);

  // If the last recorded step is already a click on this same element,
  // skip the redundant submit step — the click already captured it.
  const lastStep = steps[steps.length - 1];
  if (
    lastStep &&
    lastStep.type === "click" &&
    lastStep.selector?.css === css
  ) {
    console.log(
      "[RECORDER][handleSubmit] → skipped (click already recorded for:",
      css,
      ")",
    );
    // Still flush since navigation is about to happen
    drainPendingInputs();
    sendFlush(false);
    return;
  }

  const value =
    target.getAttribute("aria-label") ||
    target.getAttribute("title") ||
    target.getAttribute("name") ||
    getDirectTextContent(target) ||
    null;

  const step = createStep("submit", target, value);
  if (step) {
    steps.push(step);
    console.log(
      "[RECORDER][handleSubmit] ✅ submit step ADDED — total steps:",
      steps.length,
    );

    // Immediately flush since navigation is about to happen
    drainPendingInputs();
    sendFlush(false);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startRecording() {
  if (isRecording) {
    console.log(
      "[RECORDER] startRecording() called but already recording — ignoring",
    );
    return;
  }
  console.log(
    "[RECORDER] ▶▶▶ startRecording() — attaching listeners, resetting state",
  );
  isRecording = true;
  steps = [];
  variables = [];
  lastClick = { selector: null, time: 0 };
  pendingInputs.clear();

  if (!listenersAttached) {
    document.addEventListener("click", handleClick, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("blur", handleBlur, true);
    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    window.addEventListener("beforeunload", handleBeforeUnload);
    listenersAttached = true;
    console.log("[RECORDER] ✅ event listeners ATTACHED (capture phase)");
  } else {
    console.log(
      "[RECORDER] event listeners already attached (listenersAttached=true)",
    );
  }

  if (!flushIntervalId) {
    flushIntervalId = window.setInterval(periodicFlush, FLUSH_INTERVAL_MS);
    console.log(
      "[RECORDER] ✅ periodic flush started, interval:",
      FLUSH_INTERVAL_MS,
      "ms",
    );
  }
}

export async function stopRecording() {
  console.log(
    "[RECORDER] ⏹⏹⏹ stopRecording() called — isRecording:",
    isRecording,
  );

  if (!isRecording) {
    console.log("[RECORDER] not recording — returning empty");
    return { steps: [], variables: [] };
  }

  isRecording = false;
  console.log("[RECORDER] isRecording → false");

  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
    console.log("[RECORDER] periodic flush stopped");
  }

  drainPendingInputs();

  console.log(
    "[RECORDER] before final flush — steps:",
    steps.length,
    "variables:",
    variables.length,
  );
  console.log(
    "[RECORDER] steps array:",
    JSON.stringify(
      steps.map((s) => ({
        type: s.type,
        css: s.selector?.css,
        value: s.value,
      })),
    ),
  );

  await sendFlush(true);

  const result = {
    steps: compressSteps([...steps]),
    variables: [...variables],
  };
  console.log(
    "[RECORDER] stopRecording result — steps:",
    result.steps.length,
    "vars:",
    result.variables.length,
  );

  steps = [];
  variables = [];

  return result;
}

export function handleCreateVariable(kind) {
  if (!isRecording) return;
  const k = kind === "output" ? "output" : "input";
  const variable = createVariable(k);
  if (variable) {
    variables.push(variable);
    console.log("[RECORDER] variable added:", variable.name);
  }
}
