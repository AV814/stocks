/* ============================================================
   LWSTOCKS — shared pixel drawpad
   One implementation of the drawing card, used by the chat
   doodle panel and the profile-picture editor, so the two can
   never drift apart. Brush (1-4px) and fill-bucket tools, the
   12-swatch palette plus a full-spectrum picker, Bresenham
   stroke interpolation with coalesced pointer events.

   createDrawPad(mount, { canvasId }) builds the UI inside
   `mount` and returns { canvas, clear, toDataURL, destroy }.
   ============================================================ */

export const PAD_PIX = 128;

const PALETTE = ["#000000", "#ffffff", "#c0392b", "#e8a33d", "#e8d44d", "#5aa03c",
  "#3aa6a6", "#3a6ea5", "#7d4fa5", "#d976a8", "#7a5230", "#8a9280"];

export function createDrawPad(mount, opts = {}) {
  const PIX = opts.pix || PAD_PIX;
  const canvasId = opts.canvasId || "pad-canvas";
  let color = "#000000";
  let brush = 1;
  let tool = "brush";      // "brush" | "fill"
  let last = null;

  mount.innerHTML = `
    <canvas id="${canvasId}" class="padcv" width="${PIX}" height="${PIX}"></canvas>
    <div class="chat-draw-side">
      <div class="chat-tools">
        <button type="button" class="ghost on" data-pad-tool="brush" title="Brush">✎</button>
        <button type="button" class="ghost" data-pad-tool="fill" title="Fill bucket">▨</button>
        <input type="color" class="pad-custom" value="#000000" title="Pick any color">
      </div>
      <label class="chat-size-l">Brush <span class="pad-size-v">1</span>px
        <input type="range" class="pad-size" min="1" max="4" step="1" value="1">
      </label>
      <div class="chat-palette">
        ${PALETTE.map((c) => `<button type="button" class="chat-swatch ${c === color ? "on" : ""}" data-pad-col="${c}" style="background:${c}"></button>`).join("")}
      </div>
    </div>`;

  const cv = mount.querySelector(`#${canvasId}`);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PIX, PIX);

  const pxOf = (clientX, clientY) => {
    const r = cv.getBoundingClientRect();
    return {
      x: Math.floor((clientX - r.left) / r.width * PIX),
      y: Math.floor((clientY - r.top) / r.height * PIX)
    };
  };
  const plot = (x, y) => {
    if (x < 0 || x >= PIX || y < 0 || y >= PIX) return;
    const off = Math.floor((brush - 1) / 2);
    const px = Math.max(0, Math.min(PIX - brush, x - off));
    const py = Math.max(0, Math.min(PIX - brush, y - off));
    ctx.fillStyle = color;
    ctx.fillRect(px, py, brush, brush);
  };
  const plotLine = (x0, y0, x1, y1) => {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const floodFill = (e) => {
    const { x, y } = pxOf(e.clientX, e.clientY);
    if (x < 0 || x >= PIX || y < 0 || y >= PIX) return;
    const img = ctx.getImageData(0, 0, PIX, PIX);
    const d = img.data;
    const at = (px, py) => (py * PIX + px) * 4;
    const t = at(x, y);
    const [tr, tg, tb, ta] = [d[t], d[t + 1], d[t + 2], d[t + 3]];
    const m = color.match(/^#(..)(..)(..)$/);
    const [nr, ng, nb] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    if (tr === nr && tg === ng && tb === nb && ta === 255) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cx >= PIX || cy < 0 || cy >= PIX) continue;
      const i = at(cx, cy);
      if (d[i] !== tr || d[i + 1] !== tg || d[i + 2] !== tb || d[i + 3] !== ta) continue;
      d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; d[i + 3] = 255;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    ctx.putImageData(img, 0, 0);
  };
  const paintAt = (e, strokeStart) => {
    const points = (e.getCoalescedEvents?.() || [e]).map((ev) => pxOf(ev.clientX, ev.clientY));
    if (strokeStart) last = null;
    for (const p of points) {
      if (last) plotLine(last.x, last.y, p.x, p.y);
      else plot(p.x, p.y);
      last = p;
    }
  };

  const onDown = (e) => {
    e.preventDefault();
    if (tool === "fill") { floodFill(e); return; }
    cv.setPointerCapture(e.pointerId);
    paintAt(e, true);
  };
  const onMove = (e) => { if (tool === "brush" && (e.buttons & 1)) paintAt(e); };
  const onUp = () => { last = null; };
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerup", onUp);

  const toolBtns = mount.querySelectorAll("[data-pad-tool]");
  toolBtns.forEach((b) => b.addEventListener("click", () => {
    tool = b.dataset.padTool;
    toolBtns.forEach((x) => x.classList.toggle("on", x === b));
  }));
  mount.querySelectorAll("[data-pad-col]").forEach((b) =>
    b.addEventListener("click", () => {
      color = b.dataset.padCol;
      mount.querySelector(".pad-custom").value = color;
      mount.querySelectorAll(".chat-swatch").forEach((x) => x.classList.toggle("on", x === b));
    }));
  mount.querySelector(".pad-custom").addEventListener("input", (e) => {
    color = e.target.value;
    mount.querySelectorAll(".chat-swatch").forEach((x) => x.classList.remove("on"));
  });
  mount.querySelector(".pad-size").addEventListener("input", (e) => {
    brush = Number(e.target.value);
    mount.querySelector(".pad-size-v").textContent = brush;
  });

  return {
    canvas: cv,
    clear() { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, PIX, PIX); },
    toDataURL() { return cv.toDataURL("image/png"); },
    destroy() {
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      mount.innerHTML = "";
    }
  };
}
