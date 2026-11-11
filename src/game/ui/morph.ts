/**
 * Minimal DOM morph: bring `el`'s children in line with `html` while keeping every element that is
 * still there. Panels re-render several times a second; replacing innerHTML would detach the very
 * button under the cursor between mousedown and mouseup, and the click would be lost.
 */
const template = document.createElement("template");

export function morph(el: Element, html: string): void {
  template.innerHTML = html;
  patchChildren(el, template.content);
}

function patchChildren(target: Node, source: Node): void {
  const want = Array.from(source.childNodes);
  let i = 0;
  for (; i < want.length; i++) {
    const s = want[i]!;
    const t = target.childNodes[i];
    if (!t) {
      target.appendChild(s.cloneNode(true));
      continue;
    }
    if (!same(t, s)) {
      target.replaceChild(s.cloneNode(true), t);
      continue;
    }
    if (t.nodeType === Node.TEXT_NODE || t.nodeType === Node.COMMENT_NODE) {
      if (t.nodeValue !== s.nodeValue) t.nodeValue = s.nodeValue;
      continue;
    }
    patchAttributes(t as Element, s as Element);
    patchChildren(t, s);
  }
  while (target.childNodes.length > want.length) target.removeChild(target.lastChild!);
}

function same(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  const ea = a as Element;
  const eb = b as Element;
  // Different element, or a different thing the element stands for: replace rather than morph.
  return ea.tagName === eb.tagName && ea.getAttribute("data-id") === eb.getAttribute("data-id") && ea.getAttribute("data-act") === eb.getAttribute("data-act");
}

function patchAttributes(t: Element, s: Element): void {
  for (const a of Array.from(t.attributes)) if (!s.hasAttribute(a.name)) t.removeAttribute(a.name);
  for (const a of Array.from(s.attributes)) if (t.getAttribute(a.name) !== a.value) t.setAttribute(a.name, a.value);
  // Form state lives in properties, not attributes.
  if (t instanceof HTMLInputElement && s instanceof HTMLInputElement && t.type === "checkbox") t.checked = s.hasAttribute("checked");
  if (t instanceof HTMLButtonElement) t.disabled = s.hasAttribute("disabled");
}
