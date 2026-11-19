import { createCropEditor, showCroppedPreview } from "./crop.js";

const $ = (name) => document.getElementById(name);
const slots = {
  portrait: { name: "人像", icon: "person" },
  costume: { name: "服装", icon: "shirt" },
  pose: { name: "姿势", icon: "pose" },
  hair: { name: "发型", icon: "hair" },
};
const states = { queued: "排队中", running: "生成中", success: "已完成", error: "生成失败", cancelled: "已取消" };
const modelName = (job) => job.model === "h3-image" ? "H3 Image" : "Qwen 2.1";
const pending = (record) => record && ["queued", "running"].includes(record.state);
const form = $("compose");
const gallery = $("gallery");
const historyDialog = $("history");
const image = $("result-image");
const generate = $("generate");
const app = {
  selections: load("selections", {}),
  randomSlots: new Set(load("random-slots", [])),
  uploads: load("uploads", []),
  defaults: {},
  jobs: load("jobs", []),
  viewId: null,
  activeIds: new Set(),
  online: false,
  submitting: false,
  shuffling: false,
};
let openSlot = null;
let gallerySource = "built-in";
let galleryRequest = null;
let searchTimer = null;
let galleryPage = 1;
let pollTimer = null;
let polling = false;
let batchView = "";
let galleryClickTimer = null;
const cropEditor = createCropEditor($("crop-dialog"));

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`qwen-studio-${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`qwen-studio-${key}`, JSON.stringify(value));
  } catch {
    // Private browser sessions may disable local storage.
  }
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "请求未完成，请重试");
    error.status = response.status;
    throw error;
  }
  return data;
}

function post(url, data) {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

function message(node, text) {
  node.textContent = text;
  node.hidden = !text;
}

function renderReferences() {
  const refs = $("references");
  if (!refs.children.length) {
    for (const [kind, slot] of Object.entries(slots)) {
      const entry = document.createElement("div");
      entry.className = "reference-entry";
      const card = document.createElement("button");
      card.type = "button";
      card.className = "reference-card";
      card.dataset.kind = kind;
      const photo = document.createElement("span");
      photo.className = "reference-photo";
      const label = document.createElement("span");
      label.className = "card-label";
      const title = document.createElement("strong");
      title.append(icon(slot.icon), slot.name);
      label.append(title, icon("chevron"));
      card.append(photo, label);
      card.addEventListener("click", (event) => {
        clearTimeout(galleryClickTimer);
        if (event.detail && photo.contains(event.target) && app.selections[kind]) {
          if (event.detail === 1) galleryClickTimer = setTimeout(() => openGallery(kind), 380);
        } else {
          openGallery(kind);
        }
      });
      photo.addEventListener("dblclick", (event) => {
        if (!app.selections[kind]) return;
        event.preventDefault();
        openCrop(kind);
      });
      const cropButton = document.createElement("button");
      cropButton.type = "button";
      cropButton.className = "button icon-button reference-crop";
      cropButton.setAttribute("aria-label", `裁剪${slot.name}`);
      cropButton.title = `裁剪${slot.name}`;
      cropButton.append(icon("crop"));
      cropButton.addEventListener("click", () => openCrop(kind));
      const randomButton = document.createElement("button");
      randomButton.type = "button";
      randomButton.className = "button reference-random";
      randomButton.setAttribute("role", "switch");
      randomButton.setAttribute("aria-label", `随机选择${slot.name}`);
      const track = document.createElement("span");
      track.className = "switch-track";
      track.setAttribute("aria-hidden", "true");
      const randomLabel = document.createElement("span");
      randomLabel.className = "switch-label";
      randomLabel.textContent = "随机";
      randomButton.title = `随机选择${slot.name}`;
      randomButton.append(track, randomLabel);
      randomButton.addEventListener("click", () => {
        clearTimeout(galleryClickTimer);
        if (app.randomSlots.has(kind)) app.randomSlots.delete(kind);
        else app.randomSlots.add(kind);
        save("random-slots", [...app.randomSlots]);
        renderReferences();
      });
      entry.append(card, cropButton, randomButton);
      refs.append(entry);
    }
  }
  for (const entry of refs.children) {
    const card = entry.firstElementChild;
    const cropButton = entry.querySelector(".reference-crop");
    const kind = card.dataset.kind;
    const item = app.selections[kind];
    entry.querySelector(".reference-random").setAttribute("aria-checked", String(app.randomSlots.has(kind)));
    const photo = card.firstElementChild;
    const text = item ? `${slots[kind].name}：${item.name}` : `选择${slots[kind].name}`;
    card.setAttribute("aria-label", text);
    card.title = text;
    cropButton.hidden = !item;
    cropButton.toggleAttribute("data-cropped", Boolean(item?.crop));
    if (!item) {
      photo.replaceChildren(icon("add"));
    } else {
      const key = JSON.stringify([item.url, item.crop?.rect]);
      if (photo.firstElementChild?.dataset.preview === key) continue;
      const img = document.createElement("img");
      img.alt = "";
      img.src = item.url;
      img.dataset.preview = key;
      img.draggable = false;
      img.addEventListener("error", () => { if (img.isConnected) photo.replaceChildren(icon("image")); }, { once: true });
      photo.replaceChildren(img);
      if (item.crop) showCroppedPreview(img, item, kind).catch(() => {});
    }
  }
}

function openCrop(kind) {
  clearTimeout(galleryClickTimer);
  const item = app.selections[kind];
  if (!item || gallery.open) return;
  cropEditor(item, kind, slots[kind].name, (crop) => {
    if (app.selections[kind] === item) selectItem(kind, { ...item, crop });
  });
}

function selectItem(kind, item) {
  app.selections[kind] = item;
  save("selections", app.selections);
  renderReferences();
  message($("form-message"), "");
  if (gallery.open && openSlot === kind) {
    gallery.close();
    document.querySelector(`.reference-card[data-kind="${kind}"]`)?.focus();
  }
}

function galleryQuery(page) {
  return new URLSearchParams({
    q: $("gallery-search").value,
    category: $("gallery-category").value,
    page,
  });
}

function openGallery(kind) {
  clearTimeout(galleryClickTimer);
  if (gallery.open || $("crop-dialog").open) return;
  openSlot = kind;
  $("gallery-title").textContent = `选择${slots[kind].name}`;
  $("gallery-search").value = "";
  const categories = $("gallery-category");
  categories.replaceChildren(new Option("全部分类", ""));
  $("clear-slot").hidden = kind === "portrait" || !app.selections[kind];
  $("restore-slot").hidden = !app.defaults[kind] || app.selections[kind]?.id === app.defaults[kind].id;
  gallery.showModal();
  showGallerySource(app.selections[kind]?.upload ? "personal" : "built-in");
}

function showGallerySource(source) {
  gallerySource = source;
  const personal = source === "personal";
  $("built-in-gallery").setAttribute("aria-pressed", String(!personal));
  $("personal-gallery").setAttribute("aria-pressed", String(personal));
  $("gallery-category").closest(".gallery-filter").hidden = personal;
  $("gallery-random").hidden = personal;
  clearTimeout(searchTimer);
  loadGallery();
}

function appendGalleryItems(kind, items) {
  for (const item of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "gallery-item";
    card.dataset.kind = kind;
    card.title = item.name;
    const current = app.selections[kind];
    const chosen = item.upload ? current?.upload === item.upload : current?.id === item.id;
    card.setAttribute("aria-pressed", String(chosen));
    const thumbnail = document.createElement("img");
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.src = item.url;
    const label = document.createElement("span");
    label.textContent = item.name;
    card.append(thumbnail, label);
    if (chosen) card.append(icon("check"));
    card.addEventListener("click", () => selectItem(kind, chosen ? current : item));
    $("gallery-grid").append(card);
  }
}

async function loadGallery(page = 1) {
  if (!gallery.open) return;
  galleryRequest?.abort();
  galleryRequest = new AbortController();
  const controller = galleryRequest;
  const kind = openSlot;
  const params = galleryQuery(page);
  $("gallery-more").hidden = true;
  if (page === 1) {
    $("gallery-grid").replaceChildren();
    $("gallery-scroll").scrollTop = 0;
    message($("gallery-message"), "正在加载素材…");
  }
  if (gallerySource === "personal") {
    const search = params.get("q").trim().toLowerCase();
    const items = app.uploads.filter((item) => item.name.toLowerCase().includes(search));
    message($("gallery-message"), items.length ? "" : app.uploads.length ? "没有找到素材" : "还没有上传图片");
    appendGalleryItems(kind, items);
    return;
  }
  try {
    const data = await request(`/api/gallery/${kind}?${params}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const select = $("gallery-category");
    const category = params.get("category");
    select.replaceChildren(new Option("全部分类", ""), ...data.categories.map((value) => new Option(value, value)));
    select.value = category;
    message($("gallery-message"), data.total ? "" : "没有找到素材");
    appendGalleryItems(kind, data.items);
    galleryPage = data.page;
    $("gallery-more").hidden = !data.more;
  } catch (error) {
    if (error.name !== "AbortError") message($("gallery-message"), error.message);
  }
}

async function randomItem(kind, params = new URLSearchParams()) {
  params.set("random", "1");
  return request(`/api/gallery/${kind}?${params}`);
}

$("shuffle").addEventListener("click", async () => {
  app.shuffling = true;
  $("shuffle").disabled = true;
  message($("form-message"), "");
  try {
    const kinds = Object.keys(slots);
    const items = await Promise.all(kinds.map((kind) => randomItem(kind)));
    app.selections = Object.fromEntries(kinds.map((kind, i) => [kind, items[i]]));
    save("selections", app.selections);
    renderReferences();
  } catch (error) {
    message($("form-message"), error.message);
  } finally {
    app.shuffling = false;
    $("shuffle").disabled = !app.online;
  }
});

$("gallery-random").addEventListener("click", async () => {
  const kind = openSlot;
  const button = $("gallery-random");
  button.disabled = true;
  try {
    const item = await randomItem(kind, galleryQuery(1));
    if (gallery.open && openSlot === kind && gallerySource === "built-in") selectItem(kind, item);
  } catch (error) {
    message($("gallery-message"), error.message);
  } finally {
    button.disabled = false;
  }
});
$("built-in-gallery").addEventListener("click", () => showGallerySource("built-in"));
$("personal-gallery").addEventListener("click", () => showGallerySource("personal"));
$("gallery-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadGallery(), 220);
});
$("gallery-category").addEventListener("change", () => {
  clearTimeout(searchTimer);
  loadGallery();
});
$("gallery-more").addEventListener("click", () => loadGallery(galleryPage + 1));
$("clear-slot").addEventListener("click", () => selectItem(openSlot, null));
$("restore-slot").addEventListener("click", () => selectItem(openSlot, app.defaults[openSlot]));
gallery.addEventListener("close", () => {
  clearTimeout(searchTimer);
  galleryRequest?.abort();
});

function rememberUpload(item) {
  if (!item?.upload || app.uploads.some((entry) => entry.upload === item.upload)) return;
  app.uploads.unshift({ upload: item.upload, url: item.url, name: item.name });
  save("uploads", app.uploads);
}

$("pick-upload").addEventListener("click", () => $("upload-input").click());
$("upload-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const kind = openSlot;
  const button = $("pick-upload");
  if (file.size > 12 * 1024 * 1024) {
    message($("gallery-message"), "图片超过 12 MB");
    return;
  }
  button.disabled = true;
  message($("gallery-message"), "正在上传…");
  try {
    const item = await request("/api/uploads", { method: "POST", body: file });
    item.name = file.name;
    rememberUpload(item);
    selectItem(kind, item);
  } catch (error) {
    message($("gallery-message"), error.message);
  } finally {
    button.disabled = false;
  }
});

function remember(jobs) {
  const changed = jobs.filter((job) => app.jobs.find((entry) => entry.id === job.id)?.state !== job.state);
  if (!changed.length) return;
  const ids = new Set(changed.map((job) => job.id));
  app.jobs = [...changed, ...app.jobs.filter((entry) => !ids.has(entry.id))]
    .sort((a, b) => b.created - a.created).slice(0, 25);
  save("jobs", app.jobs);
  if (historyDialog.open) renderHistory();
}

function showImage(url, alt) {
  if (image.getAttribute("src") !== url) image.src = url;
  image.alt = alt;
  image.hidden = false;
}

function renderBatch(job) {
  const entries = job?.batch ? app.jobs.filter((entry) => entry.batch === job.batch)
    .sort((a, b) => a.position - b.position) : [];
  const key = JSON.stringify([job?.id, entries.map((entry) => [entry.id, entry.state])]);
  if (key === batchView) return;
  batchView = key;
  $("batch-results").hidden = entries.length < 2;
  if (entries.length < 2) return;
  const completed = entries.filter((entry) => entry.state === "success").length;
  message($("batch-status"), `已生成 ${completed} / ${entries.length} 张`);
  const strip = $("batch-thumbs");
  const focused = document.activeElement?.dataset.job;
  strip.replaceChildren();
  for (const entry of entries) {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "batch-thumb";
    thumb.dataset.job = entry.id;
    thumb.setAttribute("aria-pressed", String(entry.id === job.id));
    thumb.setAttribute("aria-label", `第 ${entry.position} 张，${states[entry.state]}`);
    if (entry.state === "success") {
      const img = document.createElement("img");
      img.alt = "";
      img.src = entry.image;
      thumb.append(img);
    } else {
      const label = document.createElement("span");
      label.textContent = `${entry.position} · ${states[entry.state]}`;
      thumb.append(label);
    }
    thumb.addEventListener("click", () => { app.viewId = entry.id; renderOutput(); });
    strip.append(thumb);
    if (focused === entry.id) thumb.focus({ preventScroll: true });
  }
}

function renderOutput() {
  const job = app.jobs.find(({ id }) => id === app.viewId);
  const loading = pending(job) || (app.submitting && !job);
  const success = job?.state === "success";
  const example = !job && !app.submitting;
  message($("result-type"), job ? modelName(job) : example ? "示例" : "");
  $("download").hidden = !success;
  $("expand").hidden = !success && !example;
  $("canvas-message").hidden = success || example;
  $("spinner").hidden = !loading;
  $("cancel").hidden = !pending(job);
  generate.disabled = !app.online || app.submitting || app.activeIds.size > 0;
  generate.querySelector("span").textContent = app.submitting ? "正在提交" : app.activeIds.size ? "任务进行中" : "生成图片";
  if (success) {
    showImage(job.image, "生成的造型图片");
    $("download").href = job.image + "?download=1";
  } else if (example) {
    showImage("/assets/example.webp", "造型生成示例");
  } else {
    image.hidden = true;
    const text = job?.error || (job ? states[job.state] : "正在提交任务");
    message($("job-state"), text);
  }
  renderBatch(job);
}

async function checkHealth() {
  try {
    await request("/api/health");
    app.online = true;
  } catch {
    app.online = false;
  }
  const connection = $("connection");
  connection.className = `connection ${app.online ? "online" : "offline"}`;
  connection.lastChild.textContent = app.online ? "在线" : "离线";
  $("shuffle").disabled = !app.online || app.shuffling;
  renderOutput();
}

async function poll() {
  pollTimer = null;
  polling = true;
  const reconnecting = new Set();
  const updates = await Promise.all([...app.activeIds].map(async (id) => {
    try {
      return await request(`/api/jobs/${id}`);
    } catch (error) {
      if (error.status === 404) {
        const job = app.jobs.find((entry) => entry.id === id);
        return { ...job, id, state: "error", error: "任务记录已失效" };
      }
      reconnecting.add(id);
      return null;
    }
  }));
  const known = updates.filter(Boolean);
  for (const job of known) if (!pending(job)) app.activeIds.delete(job.id);
  remember(known);
  renderOutput();
  if (reconnecting.has(app.viewId)) message($("job-state"), "正在重新连接 ComfyUI…");
  polling = false;
  if (app.activeIds.size) pollTimer = setTimeout(poll, 1400);
}

function track(jobs) {
  for (const job of jobs) if (pending(job)) app.activeIds.add(job.id);
  if (app.activeIds.size && pollTimer === null && !polling) poll();
}

function renderHistory() {
  const list = $("history-list");
  list.replaceChildren();
  if (!app.jobs.length) {
    const text = document.createElement("p");
    text.textContent = "暂无生成记录";
    list.append(text);
    return;
  }
  const format = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  for (const job of app.jobs) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "history-entry";
    const thumb = document.createElement(job.state === "success" ? "img" : "span");
    if (job.state === "success") {
      thumb.src = job.image;
      thumb.alt = "";
      thumb.loading = "lazy";
    } else {
      thumb.className = "history-icon";
      thumb.append(icon("image"));
    }
    const label = document.createElement("span");
    const date = document.createElement("strong");
    date.textContent = format.format(new Date(job.created * 1000));
    const status = document.createElement("small");
    status.textContent = modelName(job) + " · " + states[job.state];
    label.append(date, status);
    entry.append(thumb, label, icon("chevron"));
    entry.addEventListener("click", () => {
      app.viewId = job.id;
      if (pending(job)) track([job]);
      historyDialog.close();
      renderOutput();
      revealOutput();
    });
    list.append(entry);
  }
}

function revealOutput() {
  if (matchMedia("(max-width: 650px)").matches) {
    $("result-title").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (app.submitting || app.activeIds.size || !app.online) return;
  const instruction = $("instruction").value.trim();
  if (!app.selections.portrait && !app.randomSlots.has("portrait")) {
    message($("form-message"), "请先选择人像");
    openGallery("portrait");
    return;
  }
  if (Object.keys(slots).filter((key) => app.selections[key] || app.randomSlots.has(key)).length < 2 && !instruction) {
    message($("form-message"), "请选择一项造型素材，或填写补充提示词");
    return;
  }
  const refs = {};
  for (const [kind, item] of Object.entries(app.selections)) {
    if (!item || !slots[kind]) continue;
    refs[kind] = item.upload ? { upload: item.upload } : { id: item.id };
    if (item.crop) refs[kind].crop = item.crop.rect;
  }
  const previous = app.viewId;
  app.viewId = null;
  app.submitting = true;
  message($("form-message"), "");
  renderOutput();
  revealOutput();
  try {
    const job = await post("/api/jobs", {
      model: form.elements.model.value, references: refs, instruction, ratio: $("ratio").value,
      count: Number($("count").value), randomize: [...app.randomSlots],
    });
    const jobs = job.jobs || [job];
    remember(jobs);
    app.viewId = job.id;
    track(jobs);
    if (job.warning) message($("form-message"), job.warning);
  } catch (error) {
    app.viewId = previous;
    message($("form-message"), error.message);
    if (matchMedia("(max-width: 650px)").matches) $("form-message").scrollIntoView({ block: "center" });
  } finally {
    app.submitting = false;
    renderOutput();
  }
});

$("cancel").addEventListener("click", async () => {
  const id = app.viewId;
  const button = $("cancel");
  if (!id) return;
  button.disabled = true;
  try {
    const result = await post(`/api/jobs/${id}/cancel`, {});
    if (result.cancelled && app.activeIds.has(id) && app.viewId === id) {
      message($("job-state"), "正在取消…");
    }
  } catch (error) {
    message($("job-state"), error.message);
  } finally {
    button.disabled = false;
  }
});

$("open-history").addEventListener("click", () => {
  renderHistory();
  historyDialog.showModal();
});
$("expand").addEventListener("click", () => {
  $("lightbox-image").src = image.src;
  $("lightbox").showModal();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
});
$("instruction").value = load("instruction", "");
$("ratio").value = load("ratio", "原始比例");
$("count").value = load("count", "1");
form.elements.model.value = load("model", "qwen") === "h3-image" ? "h3-image" : "qwen";
document.querySelectorAll(".model-picker input").forEach((radio) => {
  radio.addEventListener("change", () => save("model", form.elements.model.value));
});
$("instruction").addEventListener("input", () => save("instruction", $("instruction").value));
$("ratio").addEventListener("change", () => save("ratio", $("ratio").value));
$("count").addEventListener("change", () => save("count", $("count").value));

async function defaults() {
  try {
    app.defaults = await request("/api/defaults");
    app.selections = { ...app.defaults, ...app.selections };
    renderReferences();
  } catch {
    if (!Object.keys(app.selections).length) setTimeout(defaults, 6000);
  }
}

Object.values(app.selections).forEach(rememberUpload);
renderReferences();
app.viewId = app.jobs[0]?.id || null;
track(app.jobs);
renderOutput();
defaults();
checkHealth();
setInterval(checkHealth, 12000);
