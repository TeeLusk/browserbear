// Annotate a page for a Threadbear thread: select elements, mark regions or
// draw, add a comment, then Attach. Injected by background.js (ops.annotate)
// into this extension's isolated world, so the page can't see or call it.
// Attach hides the controls and tells the background worker, which takes the
// screenshot and hands everything to the service; it never sends a message
// to an agent by itself.
//
// Selection geometry, clipped outlines, marquee selection and segmented freehand
// paths adapted from T3 Code (revision 59e64eef881632a23f89c4138bcf37f23d92bf93,
// apps/desktop/src/preview/PickPreload.ts and AnnotationStroke.ts), by way of
// jwsandeman's Threadbear fork. Copyright (c) 2026 T3 Tools Inc. MIT; see
// annotation.LICENSE.
globalThis.__browserbearAnnotate = function (sessionId, threadTitle) {
  "use strict";
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) throw new Error("Invalid annotation session.");
  const forThread = typeof threadTitle === "string" && threadTitle ? threadTitle.slice(0, 80) : "the thread";
  const previous = window.__threadbearAnnotation;
  if (previous?.sessionId === sessionId) return previous.read();
  previous?.finish?.();

  const ATTRIBUTE = "data-threadbear-annotation-ui";
  const TOOL_ATTRIBUTE = "data-threadbear-annotation-tool";
  const SVG = "http://www.w3.org/2000/svg";
  const MAX_TARGETS = 20;
  const MAX_POINTS = 2048;
  let tool = "select", status = "active", annotation = null, finished = false;
  let dragStart = null, activeStroke = null, pointCount = 0, repaintFrame = null;
  const selected = new Map(), regions = [], strokes = [], listeners = [];
  const focusBefore = document.activeElement;
  const originalTool = document.documentElement.getAttribute(TOOL_ATTRIBUTE);
  const host = document.createElement("div");
  host.setAttribute(ATTRIBUTE, "");
  host.style.cssText = "position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483646;color-scheme:dark;";
  const shadow = host.attachShadow({ mode: "closed" });
  const root = shadow.appendChild(document.createElement("div"));
  root.className = "root";
  const style = shadow.appendChild(document.createElement("style"));
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .root { color:#f5f5f5; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.4; }
    .toolbar,.editor { position:fixed; pointer-events:auto; border:1px solid #414141; background:#000; box-shadow:0 10px 30px #0005; border-radius:12px; z-index:10; }
    .toolbar { top:14px; left:50%; transform:translateX(-50%); display:flex; padding:5px; gap:3px; max-width:calc(100vw - 16px); }
    button { appearance:none; color:#eee; background:transparent; border:1px solid transparent; border-radius:7px; font:inherit; font-weight:500; min-height:34px; padding:5px 11px; cursor:pointer; white-space:nowrap; }
    button:hover { background:#242424; }
    button[aria-pressed=true] { color:#37ebf3; background:#153638; }
    button:focus-visible,textarea:focus-visible { outline:2px solid #37ebf3; outline-offset:2px; }
    button:disabled { opacity:.45; cursor:default; }
    .close { border-left-color:#333; margin-left:4px; }
    .editor { right:16px; bottom:16px; width:330px; max-width:calc(100vw - 32px); padding:12px; }
    .for { display:block; font-weight:600; margin:0 0 4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .status { display:block; color:#c5c5c5; margin:0 0 8px; font-size:12px; }
    textarea { display:block; width:100%; min-height:72px; max-height:30vh; resize:vertical; border:1px solid #414141; border-radius:7px; background:#101010; color:#fff; padding:9px; font:inherit; cursor:text; }
    textarea::placeholder { color:#999; }
    .footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:9px; }
    .hint { font-size:11px; color:#aaa; }
    .attach { background:#37ebf3; color:#001d1f; }
    .attach:hover { background:#7bf3f8; }
    .box { position:fixed; left:0; top:0; pointer-events:none; border:2px solid #37ebf3; background:#37ebf318; border-radius:3px; z-index:1; display:none; }
    .hover { border-style:dashed; background:transparent; }
    .label { position:fixed; top:0; left:0; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#001d1f; background:#37ebf3; border-radius:4px; padding:2px 5px; font-size:11px; font-weight:600; pointer-events:none; z-index:2; }
    svg { position:fixed; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; z-index:1; }
    [hidden] { display:none !important; }
    @media(max-width:420px) { button { padding:5px 7px; } .toolbar { gap:0; } }
  `;
  const cursorStyle = document.createElement("style");
  cursorStyle.textContent = `:root[${TOOL_ATTRIBUTE}] * { cursor:crosshair !important; }`;
  document.documentElement.appendChild(cursorStyle);
  const toolbar = root.appendChild(document.createElement("div"));
  toolbar.className = "toolbar"; toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "Annotate page");
  const editor = root.appendChild(document.createElement("div")); editor.className = "editor";
  const summary = editor.appendChild(document.createElement("span")); summary.className = "status"; summary.setAttribute("role", "status");
  const comment = editor.appendChild(document.createElement("textarea"));
  comment.setAttribute("aria-label", "Describe the change"); comment.placeholder = "Describe the change…"; comment.maxLength = 4000;
  const footer = editor.appendChild(document.createElement("div")); footer.className = "footer";
  const hint = footer.appendChild(document.createElement("span")); hint.className = "hint"; hint.textContent = "Enter attaches · Shift+Enter new line";
  const heading = editor.insertBefore(document.createElement("span"), summary); heading.className = "for"; heading.textContent = `For ${forThread}`;
  function button(label, title, container, action) {
    const node = container.appendChild(document.createElement("button"));
    node.type = "button"; node.textContent = label; node.title = title; node.setAttribute("aria-label", label);
    node.addEventListener("click", action); return node;
  }
  const toolButtons = new Map();
  for (const [name, label, key] of [["select", "Select", "V"], ["region", "Region", "R"], ["draw", "Draw", "D"], ["erase", "Erase", "E"]]) {
    toolButtons.set(name, button(label, `${label} (${key})`, toolbar, () => setTool(name)));
  }
  button("Cancel", "Cancel annotation (Esc)", toolbar, cancel).className = "close";
  const attach = button("Attach", `Put your comment, the marked elements and a screenshot in ${forThread}'s message box (Enter)`, footer, submit); attach.className = "attach";
  const svg = root.appendChild(document.createElementNS(SVG, "svg"));
  svg.setAttribute("aria-hidden", "true");
  const strokeLayer = svg.appendChild(document.createElementNS(SVG, "g"));
  function box(className = "") {
    const node = root.appendChild(document.createElement("div")); node.className = `box ${className}`; return node;
  }
  const hover = box("hover"), marquee = box();
  function listen(target, name, callback, options = true) {
    target.addEventListener(name, callback, options); listeners.push(() => target.removeEventListener(name, callback, options));
  }
  function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  function fromOverlay(event) { return event.composedPath().includes(host); }
  function positionBox(node, rect) {
    node.style.display = rect.width > 0 && rect.height > 0 ? "block" : "none";
    node.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    node.style.width = `${Math.max(0, rect.width)}px`; node.style.height = `${Math.max(0, rect.height)}px`;
  }
  function normalizeRect(startX, startY, endX, endY) {
    return { x: Math.min(startX, endX), y: Math.min(startY, endY), width: Math.abs(endX - startX), height: Math.abs(endY - startY) };
  }
  function viewportRect(rect) { return { x: rect.x - scrollX, y: rect.y - scrollY, width: rect.width, height: rect.height }; }
  function visibleElementRect(element) {
    const rect = element.getBoundingClientRect();
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(document.documentElement.clientWidth, rect.right), bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
    if (getComputedStyle(element).position !== "fixed") {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor === document.body || ancestor === document.documentElement) break;
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
        const clipLeft = bounds.left + ancestor.clientLeft, clipTop = bounds.top + ancestor.clientTop;
        if (style.overflowX !== "visible") { left = Math.max(left, clipLeft); right = Math.min(right, clipLeft + ancestor.clientWidth); }
        if (style.overflowY !== "visible") { top = Math.max(top, clipTop); bottom = Math.min(bottom, clipTop + ancestor.clientHeight); }
      }
    }
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }
  function describe(element) {
    return element.tagName.toLowerCase() + (element.id ? `#${element.id}` : "") + Array.from(element.classList).slice(0, 2).map(x => `.${x}`).join("");
  }
  function pick(x, y) {
    const candidate = document.elementsFromPoint(x, y).find(e => e !== host && e !== cursorStyle && e !== document.documentElement && e !== document.body);
    if (!candidate) return null;
    let leaf = candidate;
    // Open web-component roots expose their own hit testing; closed roots remain a host.
    for (let depth = 0; depth < 10 && leaf.shadowRoot?.elementFromPoint; depth++) {
      const child = leaf.shadowRoot.elementFromPoint(x, y);
      if (!child || child === leaf) break;
      leaf = child;
    }
    return leaf;
  }
  function updateStatus(message) {
    const count = selected.size + regions.length + strokes.length;
    summary.textContent = message || (count ? `${count} selected · Shift-click to add elements` : "Select an element, mark a region or draw.");
    attach.disabled = count === 0 || status !== "active";
  }
  function setTool(name) {
    if (status !== "active") return;
    discardDrag(); tool = name; hover.style.display = "none";
    for (const [key, node] of toolButtons) node.setAttribute("aria-pressed", String(key === tool));
    document.documentElement.setAttribute(TOOL_ATTRIBUTE, tool);
  }
  function removeSelected(target) { target.outline.remove(); target.label.remove(); selected.delete(target.element); }
  function addSelected(element) {
    if (selected.has(element)) return;
    if (selected.size >= MAX_TARGETS) { updateStatus("Keep each annotation to 20 elements."); return; }
    const outline = box(), label = root.appendChild(document.createElement("div")); label.className = "label";
    selected.set(element, { element, outline, label }); repaint();
  }
  function repaint() {
    repaintFrame = null;
    if (finished || status !== "active") return;
    for (const target of selected.values()) {
      const rect = target.element.isConnected ? visibleElementRect(target.element) : { x: 0, y: 0, width: 0, height: 0 };
      positionBox(target.outline, rect); target.label.hidden = rect.width === 0 || rect.height === 0;
      target.label.textContent = describe(target.element);
      target.label.style.transform = `translate(${Math.max(4, rect.x)}px, ${Math.max(4, rect.y - 21)}px)`;
    }
    for (const region of regions) positionBox(region.node, viewportRect(region.rect));
    strokeLayer.setAttribute("transform", `translate(${-scrollX} ${-scrollY})`);
  }
  function queueRepaint() { if (repaintFrame === null) repaintFrame = requestAnimationFrame(repaint); }
  function selectElementsInRect(rect) {
    const candidates = Array.from(document.querySelectorAll("body *"))
      .filter(element => element !== host && element !== cursorStyle)
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ element, rect: candidate }) => {
        if (candidate.width < 2 || candidate.height < 2) return false;
        const centerX = candidate.left + candidate.width / 2, centerY = candidate.top + candidate.height / 2;
        return centerX >= rect.x && centerX <= rect.x + rect.width && centerY >= rect.y && centerY <= rect.y + rect.height &&
          (element.children.length === 0 || element.matches("button,a,[role=button]"));
      }).sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height).slice(0, MAX_TARGETS - selected.size);
    for (const candidate of candidates) addSelected(candidate.element);
    return candidates.length;
  }
  // T3's paths settle 100 quadratic segments at a time, keeping long strokes responsive.
  function startStroke(point) {
    return { points: [point], minX: point.x, minY: point.y, maxX: point.x, maxY: point.y, openPath: `M ${point.x} ${point.y}`, openSegments: 0 };
  }
  function addStrokePoint(geometry, point) {
    const previous = geometry.points[geometry.points.length - 1]; let closedPath = null;
    if (geometry.points.length > 1) {
      const midX = (previous.x + point.x) / 2, midY = (previous.y + point.y) / 2;
      geometry.openPath += ` Q ${previous.x} ${previous.y} ${midX} ${midY}`;
      if (++geometry.openSegments === 100) { closedPath = geometry.openPath; geometry.openPath = `M ${midX} ${midY}`; geometry.openSegments = 0; }
    }
    geometry.points.push(point); geometry.minX = Math.min(geometry.minX, point.x); geometry.minY = Math.min(geometry.minY, point.y);
    geometry.maxX = Math.max(geometry.maxX, point.x); geometry.maxY = Math.max(geometry.maxY, point.y); return closedPath;
  }
  function openStrokePath(geometry) { const last = geometry.points[geometry.points.length - 1]; return `${geometry.openPath} L ${last.x} ${last.y}`; }
  function strokeBounds(geometry) { return { x: geometry.minX - 7, y: geometry.minY - 7, width: geometry.maxX - geometry.minX + 14, height: geometry.maxY - geometry.minY + 14 }; }
  function inside(point, rect) { return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height; }
  function removeAt(x, y) {
    for (const target of Array.from(selected.values()).reverse()) {
      const r = target.element.getBoundingClientRect();
      if (inside({ x, y }, { x: r.left, y: r.top, width: r.width, height: r.height })) { removeSelected(target); updateStatus(); return; }
    }
    const point = { x: x + scrollX, y: y + scrollY };
    for (let i = regions.length - 1; i >= 0; i--) if (inside(point, regions[i].rect)) { regions.splice(i, 1)[0].node.remove(); updateStatus(); return; }
    for (let i = strokes.length - 1; i >= 0; i--) if (inside(point, strokeBounds(strokes[i].geometry))) {
      const stroke = strokes.splice(i, 1)[0]; pointCount -= stroke.geometry.points.length; stroke.group.remove(); updateStatus(); return;
    }
  }
  function discardDrag() {
    if (activeStroke) { pointCount -= activeStroke.geometry.points.length; activeStroke.group.remove(); }
    dragStart = null; activeStroke = null; marquee.style.display = "none";
  }
  function onDown(event) {
    if (fromOverlay(event)) return;
    stop(event);
    if (status !== "active" || event.button !== 0) return;
    if (tool === "select") {
      const target = pick(event.clientX, event.clientY);
      if (target) {
        const current = selected.get(target);
        if (!event.shiftKey) for (const entry of Array.from(selected.values())) if (entry !== current) removeSelected(entry);
        if (current) removeSelected(current); else addSelected(target);
      }
      updateStatus(); return;
    }
    if (tool === "erase") { removeAt(event.clientX, event.clientY); return; }
    if ((tool === "draw" && (strokes.length >= MAX_TARGETS || pointCount >= MAX_POINTS)) || (tool === "region" && regions.length >= MAX_TARGETS)) {
      updateStatus("This annotation is full. Attach it, then start another."); return;
    }
    dragStart = { x: event.clientX + scrollX, y: event.clientY + scrollY };
    if (tool === "draw") {
      const geometry = startStroke(dragStart), group = strokeLayer.appendChild(document.createElementNS(SVG, "g"));
      group.setAttribute("fill", "none"); group.setAttribute("stroke", "#37ebf3"); group.setAttribute("stroke-width", "4");
      group.setAttribute("stroke-linecap", "round"); group.setAttribute("stroke-linejoin", "round");
      activeStroke = { geometry, group, path: group.appendChild(document.createElementNS(SVG, "path")) }; pointCount++;
    }
  }
  function onMove(event) {
    if (status !== "active") return;
    if (fromOverlay(event) && !dragStart) { hover.style.display = "none"; return; }
    if (tool === "select" && !dragStart) {
      const target = pick(event.clientX, event.clientY);
      if (target) positionBox(hover, visibleElementRect(target)); else hover.style.display = "none";
      return;
    }
    hover.style.display = "none";
    if (!dragStart) return;
    stop(event);
    if (tool === "region") positionBox(marquee, viewportRect(normalizeRect(dragStart.x, dragStart.y, event.clientX + scrollX, event.clientY + scrollY)));
    if (tool === "draw" && activeStroke && pointCount < MAX_POINTS) {
      const point = { x: event.clientX + scrollX, y: event.clientY + scrollY };
      const last = activeStroke.geometry.points.at(-1);
      if (Math.hypot(point.x - last.x, point.y - last.y) < 1) return;
      const closedPath = addStrokePoint(activeStroke.geometry, point); pointCount++;
      if (closedPath !== null) { activeStroke.path.setAttribute("d", closedPath); activeStroke.path = activeStroke.group.appendChild(document.createElementNS(SVG, "path")); }
      activeStroke.path.setAttribute("d", openStrokePath(activeStroke.geometry));
    }
  }
  function onUp(event) {
    if (!dragStart) return;
    stop(event);
    if (tool === "region") {
      const rect = normalizeRect(dragStart.x, dragStart.y, event.clientX + scrollX, event.clientY + scrollY);
      if (rect.width >= 3 && rect.height >= 3) {
        // A region always survives as a visual mark, even when it also selects elements.
        regions.push({ rect, node: box() }); selectElementsInRect(viewportRect(rect));
      }
    } else if (activeStroke) {
      if (activeStroke.geometry.points.length > 1) strokes.push(activeStroke);
      else { activeStroke.group.remove(); pointCount--; }
      activeStroke = null;
    }
    dragStart = null; marquee.style.display = "none"; repaint(); updateStatus();
  }
  function selector(element, shadowDepth = 0) {
    const escape = value => CSS.escape(value);
    const segments = [];
    for (let node = element, n = 0; node && node.nodeType === 1 && n < 8; node = node.parentElement, n++) {
      if (node.id) { segments.unshift(`#${escape(node.id)}`); break; }
      let segment = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(e => e.tagName === node.tagName);
        if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      segments.unshift(segment);
    }
    const boundary = element.getRootNode();
    const prefix = boundary instanceof ShadowRoot && shadowDepth < 5 ? `${selector(boundary.host, shadowDepth + 1)} >>> ` : "";
    return (prefix + segments.join(" > ")).slice(0, 1000);
  }
  function captureElement(element) {
    const computed = getComputedStyle(element), styles = {};
    for (const name of ["display", "position", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "width", "height", "margin", "padding", "gap", "border", "border-radius", "align-items", "justify-content"]) styles[name] = computed.getPropertyValue(name).slice(0, 200);
    const rect = element.getBoundingClientRect();
    const copy = element.cloneNode(true);
    // Form values and executable inline code are irrelevant to a layout annotation.
    for (const node of [copy, ...copy.querySelectorAll("*")]) {
      for (const attr of Array.from(node.attributes)) if (/^(value|srcdoc|on.*)$/i.test(attr.name)) node.removeAttribute(attr.name);
      if (node.matches("textarea,script,style")) node.textContent = "";
    }
    return { selector: selector(element), tagName: element.tagName.toLowerCase(), outerHTML: copy.outerHTML.slice(0, 2000), text: (element.matches("input,textarea") ? "" : copy.textContent || "").slice(0, 1000), styles, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
  }
  function submit() {
    if (status !== "active" || attach.disabled) return;
    discardDrag(); repaint();
    try {
      annotation = {
        url: location.href.slice(0, 4096), title: document.title.slice(0, 500), comment: comment.value.trim().slice(0, 4000),
        elements: Array.from(selected.values()).filter(target => target.element.isConnected).map(target => captureElement(target.element)),
        regions: regions.map(region => viewportRect(region.rect)),
        strokes: strokes.map(stroke => ({ points: stroke.geometry.points.map(point => ({ x: point.x - scrollX, y: point.y - scrollY })) })),
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
      };
      if (!annotation.elements.length && !annotation.regions.length && !annotation.strokes.length) { updateStatus("The selected element disappeared. Select it again."); return; }
      toolbar.hidden = true; editor.hidden = true; hover.style.display = "none";
      status = "ready";
      handOver();
    } catch {
      annotation = null; updateStatus("Couldn’t capture this selection. Try a smaller element.");
    }
  }
  function onKey(event) {
    if (event.isComposing) return;
    if (event.key === "Escape") { stop(event); cancel(); return; }
    if (status !== "active") { stop(event); return; }
    if (shadow.activeElement === comment) {
      if (event.key === "Enter" && !event.shiftKey) { stop(event); submit(); }
      else event.stopImmediatePropagation();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const next = { v: "select", r: "region", d: "draw", e: "erase" }[event.key.toLowerCase()];
    if (next) { stop(event); setTool(next); }
    else if (fromOverlay(event)) event.stopImmediatePropagation();
  }
  function rehome() {
    if (finished) return;
    const modal = Array.from(document.querySelectorAll("dialog[open]")).filter(dialog => dialog.matches(":modal")).at(-1);
    const parent = modal || document.documentElement;
    if (host.parentElement === parent) return;
    parent.appendChild(host);
    // A manual popover occupies the top layer; nesting it in a modal avoids inertness.
    if (typeof host.showPopover === "function") {
      host.setAttribute("popover", "manual");
      try { host.showPopover(); } catch { host.removeAttribute("popover"); }
    }
  }
  function cleanup() {
    if (finished) return;
    finished = true; discardDrag();
    for (const remove of listeners) remove();
    resizeObserver.disconnect(); modalObserver.disconnect();
    if (repaintFrame !== null) cancelAnimationFrame(repaintFrame);
    if (originalTool === null) document.documentElement.removeAttribute(TOOL_ATTRIBUTE); else document.documentElement.setAttribute(TOOL_ATTRIBUTE, originalTool);
    cursorStyle.remove(); host.remove();
    if (focusBefore?.isConnected && typeof focusBefore.focus === "function") focusBefore.focus({ preventScroll: true });
  }
  function cancel() {
    const was = status;
    status = "cancelled"; annotation = null; cleanup();
    if (was !== "cancelled") tell({ type: "annotation-cancel", sessionId });
  }
  function tell(message) {
    try { return chrome.runtime.sendMessage(message); } catch { return Promise.reject(new Error("BrowserBear was reloaded. Start Annotate again.")); }
  }
  // Two frames, so the screenshot the worker takes no longer has the controls.
  function handOver() {
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      if (status !== "ready") return;
      let reply;
      try { reply = await tell({ type: "annotation", sessionId, annotation }); }
      catch (e) { reply = { ok: false, error: e?.message }; }
      if (status !== "ready") return;
      if (reply?.ok) { cleanup(); return; }
      // Keep what they marked, so they can try again or cancel.
      status = "active"; annotation = null; toolbar.hidden = false; editor.hidden = false;
      repaint(); updateStatus(reply?.error || "BrowserBear couldn't take this annotation. Try Attach again.");
    }));
  }
  const resizeObserver = new ResizeObserver(queueRepaint);
  const modalObserver = new MutationObserver(rehome);
  const api = Object.freeze({
    sessionId,
    read: () => JSON.parse(JSON.stringify({ sessionId, status, ...(annotation ? { annotation } : {}) })),
    finish: () => { if (status !== "ready") status = "cancelled"; cleanup(); return { sessionId, status }; },
  });
  window.__threadbearAnnotation = api;
  listen(window, "pointerdown", onDown);
  listen(window, "pointermove", onMove);
  listen(window, "pointerup", onUp);
  listen(window, "pointercancel", discardDrag);
  listen(window, "click", event => { if (!fromOverlay(event)) stop(event); });
  listen(window, "auxclick", event => { if (!fromOverlay(event)) stop(event); });
  listen(window, "contextmenu", event => { if (!fromOverlay(event)) stop(event); });
  listen(window, "keydown", onKey);
  listen(window, "wheel", event => { if (status !== "active" || dragStart) stop(event); }, { capture: true, passive: false });
  listen(window, "scroll", queueRepaint, { capture: true, passive: true });
  listen(window, "resize", queueRepaint, { passive: true });
  listen(window, "blur", () => { hover.style.display = "none"; discardDrag(); });
  listen(window, "pagehide", cancel);
  listen(window, "pageshow", () => {}); // keeps bfcache from restoring a half-finished overlay
  for (const name of ["pointerdown", "pointerup", "click", "focusin", "focusout", "wheel"]) listen(host, name, event => event.stopPropagation(), false);
  rehome(); resizeObserver.observe(document.documentElement);
  modalObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  setTool("select"); repaint(); updateStatus();
  return { sessionId, status };
};
