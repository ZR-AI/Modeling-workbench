const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function originalUrl(item, kind) {
  return item.upload ? item.url : `/api/gallery/${kind}/source?${new URLSearchParams({ id: item.id })}`;
}

async function loadImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

export async function showCroppedPreview(target, item, kind) {
  const source = await loadImage(originalUrl(item, kind));
  const width = source.naturalWidth, height = source.naturalHeight;
  const [x, y, w, h] = item.crop.rect;
  const left = clamp(Math.round(x * width), 0, width - 1);
  const top = clamp(Math.round(y * height), 0, height - 1);
  const cw = clamp(Math.round((x + w) * width), left + 1, width) - left;
  const ch = clamp(Math.round((y + h) * height), top + 1, height) - top;
  const scale = Math.min(1, 560 / Math.max(cw, ch));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  canvas.getContext("2d").drawImage(source, left, top, cw, ch, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!target.isConnected || !blob) return;
  const url = URL.createObjectURL(blob);
  target.src = url;
  await target.decode().catch(() => {});
  URL.revokeObjectURL(url);
}

function boxBetween(anchor, point, limit, ratio) {
  const dx = point.x - anchor.x, dy = point.y - anchor.y;
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  let w = Math.abs(dx), h = Math.abs(dy);
  if (ratio) {
    const maxW = sx < 0 ? anchor.x : limit.width - anchor.x;
    const maxH = sy < 0 ? anchor.y : limit.height - anchor.y;
    w = Math.min(Math.max(w, h * ratio), maxW, maxH * ratio);
    h = w / ratio;
  }
  return { x: sx < 0 ? anchor.x - w : anchor.x, y: sy < 0 ? anchor.y - h : anchor.y, w, h };
}

export function createCropEditor(dialog) {
  const canvas = dialog.querySelector("#crop-canvas");
  const ratioPicker = dialog.querySelector("#crop-ratio");
  const apply = dialog.querySelector("#crop-apply");
  const reset = dialog.querySelector("#crop-reset");
  const status = dialog.querySelector("#crop-message");
  const ctx = canvas.getContext("2d");
  let session;

  function ratio() {
    if (ratioPicker.value === "free") return 0;
    const [w, h] = ratioPicker.value.split(":").map(Number);
    return w / h;
  }

  function paint() {
    if (!session?.image) return;
    const { width, height } = canvas;
    const { image, rect } = session;
    ctx.drawImage(image, 0, 0, width, height);
    apply.disabled = rect !== null && (rect.w < 1 || rect.h < 1);
    if (!rect) return;
    const { x, y, w, h } = rect;
    const unit = width / Math.max(1, canvas.getBoundingClientRect().width);
    ctx.fillStyle = "#0009";
    ctx.fillRect(0, 0, width, y);
    ctx.fillRect(0, y + h, width, height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, width - x - w, h);
    ctx.lineWidth = unit;
    ctx.strokeStyle = "#ffffff88";
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      ctx.moveTo(x + w * t, y);
      ctx.lineTo(x + w * t, y + h);
      ctx.moveTo(x, y + h * t);
      ctx.lineTo(x + w, y + h * t);
    }
    ctx.stroke();
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = "#ecfacd";
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = "#ecfacd";
    for (const cx of [x, x + w]) for (const cy of [y, y + h]) {
      ctx.fillRect(cx - 4 * unit, cy - 4 * unit, 8 * unit, 8 * unit);
    }
  }

  function point(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width, 0, 1) * canvas.width,
      y: clamp((event.clientY - box.top) / box.height, 0, 1) * canvas.height,
    };
  }

  const within = (p, r) => (
    r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
  );

  function corner(p, r, pointerType) {
    if (!r) return;
    const reach = (pointerType === "touch" ? 19 : 12) * canvas.width / canvas.clientWidth;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x = sx < 0 ? r.x : r.x + r.w;
      const y = sy < 0 ? r.y : r.y + r.h;
      if (Math.hypot(x - p.x, y - p.y) <= reach) {
        return { sx, sy, anchor: { x: sx < 0 ? r.x + r.w : r.x, y: sy < 0 ? r.y + r.h : r.y } };
      }
    }
  }

  function keepInside(rect, x, y) {
    return { ...rect, x: clamp(x, 0, canvas.width - rect.w), y: clamp(y, 0, canvas.height - rect.h) };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!session?.image || event.button !== 0 || session.drag) return;
    const start = point(event);
    const rect = session.rect;
    const handle = corner(start, rect, event.pointerType);
    const mode = handle ? "resize" : within(start, rect) ? "move" : "draw";
    session.drag = { id: event.pointerId, mode, start, rect, handle };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!session?.image) return;
    const p = point(event);
    const d = session.drag;
    if (!d) {
      canvas.style.cursor = corner(p, session.rect, event.pointerType) ? "nwse-resize" : within(p, session.rect) ? "move" : "crosshair";
      return;
    }
    if (d.id !== event.pointerId) return;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 3 * canvas.width / canvas.clientWidth) return;
    d.moved = true;
    if (d.mode === "move") {
      session.rect = keepInside(d.rect, d.rect.x + dx, d.rect.y + dy);
    } else if (d.mode === "resize") {
      const { anchor, sx, sy } = d.handle;
      const pin = {
        x: clamp(anchor.x + sx * Math.max(1, sx * (p.x - anchor.x)), 0, canvas.width),
        y: clamp(anchor.y + sy * Math.max(1, sy * (p.y - anchor.y)), 0, canvas.height),
      };
      session.rect = boxBetween(anchor, pin, canvas, ratio());
    } else {
      session.rect = boxBetween(d.start, p, canvas, ratio());
    }
    paint();
  });

  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(type, (event) => {
      const drag = session?.drag;
      if (drag?.id !== event.pointerId) return;
      if (type !== "pointerup" || apply.disabled) session.rect = drag.rect;
      session.drag = null;
      paint();
    });
  }

  ratioPicker.addEventListener("change", () => {
    if (!session?.image || !ratio()) return;
    const { width, height } = canvas;
    const { x, y, w, h } = session.rect || { x: 0, y: 0, w: width, h: height };
    const nextW = Math.min(w, h * ratio());
    const nextH = nextW / ratio();
    session.rect = { x: x + (w - nextW) / 2, y: y + (h - nextH) / 2, w: nextW, h: nextH };
    paint();
  });

  reset.addEventListener("click", () => {
    if (!session?.image) return;
    ratioPicker.value = "free";
    session.rect = null;
    paint();
  });

  function confirm() {
    if (apply.disabled || !session?.image) return;
    const { onSave, rect } = session;
    const { width, height } = canvas;
    const crop = rect && { ratio: ratioPicker.value, rect: [rect.x / width, rect.y / height, rect.w / width, rect.h / height] };
    onSave(crop);
    dialog.close();
  }

  apply.addEventListener("click", confirm);
  canvas.addEventListener("dblclick", confirm);
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirm();
      return;
    }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction || !session?.rect) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const { x, y } = session.rect;
    session.rect = keepInside(session.rect, x + step * direction[0], y + step * direction[1]);
    paint();
  });
  new ResizeObserver(paint).observe(canvas);
  dialog.addEventListener("close", () => { if (!dialog.open) session = null; });

  return async function open(item, kind, name, onSave) {
    if (dialog.open) return;
    const current = { onSave };
    session = current;
    dialog.querySelector("#crop-title").textContent = `裁剪${name}`;
    apply.disabled = reset.disabled = ratioPicker.disabled = true;
    status.textContent = "正在加载图片…";
    status.hidden = false;
    canvas.hidden = true;
    dialog.showModal();
    try {
      const image = await loadImage(originalUrl(item, kind));
      if (session !== current || !dialog.open) return;
      const scale = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const [x, y, w, h] = item.crop?.rect || [0.1, 0.1, 0.8, 0.8];
      current.image = image;
      current.rect = { x: x * canvas.width, y: y * canvas.height, w: w * canvas.width, h: h * canvas.height };
      ratioPicker.value = item.crop?.ratio || "free";
      reset.disabled = ratioPicker.disabled = false;
      status.hidden = true;
      canvas.hidden = false;
      paint();
    } catch {
      if (session === current && dialog.open) status.textContent = "图片无法加载，请重新选择素材";
    }
  };
}
