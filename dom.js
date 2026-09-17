// Tiny DOM helpers. All text goes through textContent – never innerHTML with data.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Inline **bold** only. */
export function inline(text) {
  const frag = document.createDocumentFragment();
  String(text).split(/(\*\*[^*]+\*\*)/g).forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(h('b', {}, part.slice(2, -2)));
    else if (part) frag.append(document.createTextNode(part));
  });
  return frag;
}

/** Minimal, safe rendering of AI text: paragraphs, bullet lists, headings, **bold**. */
export function richText(text) {
  const root = h('div', { class: 'rich' });
  let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      list ??= root.appendChild(h('ul'));
      list.append(h('li', {}, inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    root.append(heading ? h('p', {}, h('b', {}, heading[1])) : h('p', {}, inline(line)));
  }
  return root;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}
