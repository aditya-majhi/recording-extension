const MAX_DEPTH = 5;

// ── CSS Selector Strategies ──

function isStableId(id) {
  if (!id) return false;
  if (id.length > 50) return false;
  const digitRatio = (id.match(/\d/g) || []).length / id.length;
  if (digitRatio > 0.5) return false;
  if (/^[0-9a-f-]{16,}$/.test(id)) return false;
  return true;
}

function isStableClass(className) {
  if (!className) return false;
  if (className.length > 40) return false;
  const digitRatio = (className.match(/\d/g) || []).length / className.length;
  if (digitRatio > 0.3) return false;
  return true;
}

function getCssSelector(element) {
  if (!(element instanceof Element)) return null;

  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const id = element.id;
  if (isStableId(id)) return `#${CSS.escape(id)}`;

  const name = element.getAttribute("name");
  if (name)
    return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;

  if (element.classList.length > 0) {
    const stableClass = Array.from(element.classList).find(isStableClass);
    if (stableClass) {
      return `${element.tagName.toLowerCase()}.${CSS.escape(stableClass)}`;
    }
  }

  return buildNthChildCss(element);
}

function buildNthChildCss(el) {
  const parts = [];
  let element = el;
  let depth = 0;

  while (
    element &&
    element.nodeType === Node.ELEMENT_NODE &&
    depth < MAX_DEPTH
  ) {
    const parent = element.parentElement;
    if (!parent) break;

    const tag = element.tagName.toLowerCase();
    const children = Array.from(parent.children);
    const index = children.indexOf(element) + 1;
    parts.unshift(`${tag}:nth-child(${index})`);

    element = parent;
    depth++;
  }

  return parts.join(" > ");
}

// ── XPath Strategies ──

function getAbsoluteXPath(element) {
  if (!(element instanceof Element)) return null;

  const parts = [];
  let el = element;

  while (el && el.nodeType === Node.ELEMENT_NODE) {
    const parent = el.parentElement;
    if (!parent) {
      parts.unshift(el.tagName.toLowerCase());
      break;
    }

    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName,
    );
    const index = siblings.indexOf(el) + 1;
    const tag = el.tagName.toLowerCase();

    parts.unshift(siblings.length > 1 ? `${tag}[${index}]` : tag);
    el = parent;
  }

  return "/" + parts.join("/");
}

function getRelativeXPath(element) {
  if (!(element instanceof Element)) return null;

  const tag = element.tagName.toLowerCase();

  const testId = element.getAttribute("data-testid");
  if (testId) return `//${tag}[@data-testid="${testId}"]`;

  const id = element.id;
  if (isStableId(id)) return `//${tag}[@id="${id}"]`;

  const name = element.getAttribute("name");
  if (name) return `//${tag}[@name="${name}"]`;

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return `//${tag}[@aria-label="${ariaLabel}"]`;

  const placeholder = element.getAttribute("placeholder");
  if (placeholder) return `//${tag}[@placeholder="${placeholder}"]`;

  if (tag === "button" || tag === "a") {
    const text = element.textContent?.trim();
    if (text && text.length < 50) {
      return `//${tag}[normalize-space()="${text}"]`;
    }
  }

  const type = element.getAttribute("type");
  if (type) return `//${tag}[@type="${type}"]`;

  return buildAncestorXPath(element);
}

function buildAncestorXPath(el) {
  const parts = [];
  let element = el;
  let depth = 0;

  while (
    element &&
    element.nodeType === Node.ELEMENT_NODE &&
    depth < MAX_DEPTH
  ) {
    const parent = element.parentElement;
    if (!parent) break;

    const tag = element.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === element.tagName,
    );
    const index = siblings.indexOf(element) + 1;

    parts.unshift(siblings.length > 1 ? `${tag}[${index}]` : tag);
    element = parent;
    depth++;
  }

  return "//" + parts.join("/");
}

// ── Extra attributes ──

function getElementAttributes(element) {
  if (!(element instanceof Element)) return {};

  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    name: element.getAttribute("name") || null,
    type: element.getAttribute("type") || null,
    placeholder: element.getAttribute("placeholder") || null,
    ariaLabel: element.getAttribute("aria-label") || null,
    testId: element.getAttribute("data-testid") || null,
    classes: element.className ? Array.from(element.classList).join(" ") : null,
    innerText: element.textContent?.trim().slice(0, 80) || null,
    href: element instanceof HTMLAnchorElement ? element.href : null,
  };
}

// ── Variable name helpers ──

function toSafeName(str) {
  if (!str) return null;
  const cleaned = str
    .trim()
    .replace(/[^a-zA-Z0-9 _]/g, "") // remove special chars
    .replace(/\s+(.)/g, (_, c) => c.toUpperCase()) // camelCase
    .replace(/\s/g, "")
    .replace(/^[^a-zA-Z_]/, "_"); // must start letter or _

  return cleaned.length > 1 ? cleaned : null;
}

/**
 * Looks at the surrounding DOM context to infer a meaningful
 * variable name — works even when element attributes are obfuscated.
 *
 * Priority:
 *  1. Explicit attribute hints (data-testid, name, id, aria-label, placeholder)
 *  2. <label> pointing to this element via for=id
 *  3. Sibling <label> or text node immediately before/after
 *  4. Parent element's aria-label or title
 *  5. Ancestor heading text (h1–h4) + element tag
 *  6. Own visible text (buttons, links, spans)
 *  7. Fallback: tag + position
 */
export function inferVariableName(element) {
  if (!(element instanceof Element)) return "variable";

  const tag = element.tagName.toLowerCase();

  // 1. Explicit attributes (most reliable even if obfuscated)
  const sources = [
    element.getAttribute("data-testid"),
    element.getAttribute("placeholder"),
    element.getAttribute("name"),
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.id && isStableId(element.id) ? element.id : null,
  ];
  for (const src of sources) {
    const name = toSafeName(src);
    if (name) return name;
  }

  // 2. <label for="elementId"> pointing at this element
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) {
      const name = toSafeName(label.textContent);
      if (name) return name;
    }
  }

  // 3. Wrapping <label> parent
  const parentLabel = element.closest("label");
  if (parentLabel) {
    // Get label text, excluding the element's own text
    const clone = parentLabel.cloneNode(true);
    clone
      .querySelectorAll("input,select,textarea,button")
      .forEach((el) => el.remove());
    const name = toSafeName(clone.textContent);
    if (name) return name;
  }

  // 4. Preceding sibling text / label element
  let sibling = element.previousElementSibling;
  let siblingDepth = 0;
  while (sibling && siblingDepth < 3) {
    const siblingTag = sibling.tagName.toLowerCase();
    if (
      siblingTag === "label" ||
      siblingTag === "span" ||
      siblingTag === "p" ||
      siblingTag === "div"
    ) {
      const name = toSafeName(sibling.textContent);
      if (name) return name;
    }
    sibling = sibling.previousElementSibling;
    siblingDepth++;
  }

  // 5. Following sibling (for checkboxes / radios where label comes after)
  let nextSibling = element.nextElementSibling;
  if (nextSibling) {
    const nextTag = nextSibling.tagName.toLowerCase();
    if (nextTag === "label" || nextTag === "span") {
      const name = toSafeName(nextSibling.textContent);
      if (name) return name;
    }
  }

  // 6. Parent's aria-label or title
  const parent = element.parentElement;
  if (parent) {
    const parentAria =
      parent.getAttribute("aria-label") || parent.getAttribute("title");
    const name = toSafeName(parentAria);
    if (name) return `${name}${tag.charAt(0).toUpperCase() + tag.slice(1)}`;
  }

  // 7. Nearest ancestor heading h1–h4
  const heading = element.closest("section, form, fieldset, div");
  if (heading) {
    const h = heading.querySelector("h1,h2,h3,h4,legend");
    if (h) {
      const name = toSafeName(h.textContent);
      if (name) return `${name}${tag.charAt(0).toUpperCase() + tag.slice(1)}`;
    }
  }

  // 8. Own visible text (buttons, links, headings)
  if (["button", "a", "h1", "h2", "h3", "h4", "span", "p"].includes(tag)) {
    const name = toSafeName(element.textContent);
    if (name) return name;
  }

  // 9. Fallback: tag + index among siblings
  const parentEl = element.parentElement;
  if (parentEl) {
    const index =
      Array.from(parentEl.children)
        .filter((c) => c.tagName === element.tagName)
        .indexOf(element) + 1;
    return `${tag}${index}`;
  }

  return "variable";
}

// ── Public API ──

export function generateSelector(element) {
  return getCssSelector(element) || element.tagName?.toLowerCase() || "unknown";
}

export function generateAllSelectors(element) {
  if (!(element instanceof Element)) {
    return {
      css: "document",
      cssPath: "document",
      xpath: "//document",
      xpathAbsolute: "/document",
      attributes: {},
    };
  }

  return {
    css: getCssSelector(element),
    cssPath: buildNthChildCss(element),
    xpath: getRelativeXPath(element),
    xpathAbsolute: getAbsoluteXPath(element),
    attributes: getElementAttributes(element),
  };
}
