import argparse
import asyncio
from copy import deepcopy
from functools import lru_cache
import hashlib
from io import BytesIO
import json
import logging
import math
from pathlib import Path
import random
import re
import secrets
import time
from urllib.parse import quote, urlsplit
from uuid import uuid4

from aiohttp import ClientError, ClientSession, ClientTimeout, web
from PIL import Image, ImageOps, UnidentifiedImageError

ROOT = Path(__file__).resolve().parent
COMFY = ROOT.parent / "ComfyUI"
TEMPLATES = {
    "qwen": json.loads((ROOT / "workflow.json").read_text()),
    "h3-image": json.loads((ROOT / "workflow-h3-image.json").read_text()),
}
SITE = ROOT / "dist"
JOBS = ROOT / ".data" / "jobs"
UPLOADS = COMFY / "input" / "qwen-web"
OUTPUTS = COMFY / "output" / "QwenWeb"
CUSTOM_ASSETS = COMFY / "models" / "GHIL" / "自定义"
SLOTS = {
    "portrait": ("209", "人像", "fd2238cae24"),
    "costume": ("204", "服装", "WIN-0142"),
    "pose": ("203", "姿势", "upper80v2_P061_side"),
    "hair": ("202", "发型", "h-f31fd3f3647"),
}
RATIOS = {"原始比例", "3:4", "1:1", "4:3", "9:16", "16:9"}
ID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"
MAX_UPLOAD = 12 * 1024 * 1024
MAX_QUEUE = 8
MAX_UPLOAD_PIXELS = 20_000_000
IMAGE_TYPES = {".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
LOG = logging.getLogger("qwen-web")
routes = web.RouteTableDef()


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message


class ComfyError(Exception):
    def __init__(self, status, response):
        self.status = status
        self.response = response


@web.middleware
async def respond(request, handler):
    try:
        if request.method == "POST":
            origin = request.headers.get("Origin")
            expected = f"{request.scheme}://{request.host}"
            if request.headers.get("Sec-Fetch-Site") == "cross-site" or (origin and origin != expected):
                raise ApiError(403, "请求来源不受支持")
        response = await handler(request)
    except ApiError as exc:
        response = web.json_response({"error": exc.message}, status=exc.status)
    except (ClientError, TimeoutError):
        response = web.json_response({"error": "暂时无法连接 ComfyUI"}, status=503)
    except ComfyError as exc:
        LOG.warning("ComfyUI request failed (%s): %s", exc.status, str(exc.response)[:2000])
        response = web.json_response({"error": "ComfyUI 未能处理请求"}, status=502)
    except web.HTTPRequestEntityTooLarge:
        response = web.json_response({"error": "图片超过 12 MB"}, status=413)
    except web.HTTPException as exc:
        if not request.path.startswith("/api/"):
            raise
        response = web.json_response({"error": "找不到请求的内容"}, status=exc.status)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' blob:; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    if request.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


async def comfy(app, path, *, payload=None, allow_missing=False):
    async with app["client"].request(
        "GET" if payload is None else "POST", app["comfy"] + path, json=payload
    ) as response:
        if response.status == 404 and allow_missing:
            return None
        if response.status >= 400:
            raise ComfyError(response.status, await response.text())
        return await response.json()


def gallery_url(kind, item_id):
    return f"/api/gallery/{kind}/thumb?id={quote(item_id, safe='')}"


def original_custom_assets():
    manifest = ROOT.parent / "setup-goohai-assets" / "extracted-files.json"
    prefix = "GHIL/自定义/"
    if not manifest.is_file():
        return {}
    return {row["path"][len(prefix):]: row["sha256"]
            for row in json.loads(manifest.read_text()) if row["path"].startswith(prefix)}


@lru_cache(maxsize=4096)
def source_digest(path, modified, size):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def matches_package_source(item):
    if not item.get("source"):
        return True
    source = CUSTOM_ASSETS / item["source"]
    try:
        if not source.resolve().is_relative_to(CUSTOM_ASSETS.resolve()):
            return False
        stat = source.stat()
        return source_digest(source, stat.st_mtime_ns, stat.st_size) == item["sha256"]
    except OSError:
        return False


async def catalog(app, kind):
    if kind not in SLOTS:
        raise ApiError(404, "图库不存在")
    async with app["catalog_locks"][kind]:
        saved, until = app["catalog"].get(kind, ({}, 0))
        if until > time.monotonic():
            return saved
        try:
            rows = await comfy(app, f"/ghil/{kind}/catalog")
        except (ClientError, TimeoutError, ComfyError):
            if saved:
                return saved
            raise
        items = {}
        for row in rows:
            item_id = row["id"]
            source = None
            digest = None
            if row.get("custom") or item_id.startswith("__custom__/"):
                source = SLOTS[kind][1] + "/" + item_id.removeprefix("__custom__/")
                digest = app["original_custom"].get(source)
                if not digest:
                    continue
            field = {
                "portrait": ("title", "hair_zh", "thumb", "search"),
                "costume": ("", "分类", "缩略图", "检索"),
                "pose": ("姿势名称", "体系", "缩略图", "检索"),
                "hair": ("title", "hair_zh", "thumb", "search"),
            }[kind]
            name = "、".join(row.get("关键词", [])[:3]) if kind == "costume" else row.get(field[0])
            if row.get(field[2]):
                items[item_id] = {
                    "id": item_id,
                    "name": row.get("title") or name or item_id,
                    "category": row.get(field[1]) or "",
                    "thumb": row[field[2]],
                    "full": row.get("full" if kind in ("portrait", "hair") else "原图") or row[field[2]],
                    "search": f'{item_id} {row.get(field[3], "")} {name or ""}'.casefold(),
                    "source": source,
                    "sha256": digest,
                }
        app["catalog"][kind] = (items, time.monotonic() + 300)
        return items


def public_item(kind, item):
    return {**{key: item[key] for key in ("id", "name", "category")}, "url": gallery_url(kind, item["id"])}


@routes.get("/")
async def index(request):
    return web.FileResponse(SITE / "index.html")


@routes.get("/api/health")
async def health(request):
    await comfy(request.app, "/system_stats")
    return web.json_response({"connected": True})


@routes.get("/api/defaults")
async def defaults(request):
    items = await asyncio.gather(*(catalog(request.app, kind) for kind in SLOTS))
    return web.json_response({
        kind: public_item(kind, rows.get(default) or next(iter(rows.values())))
        for (kind, (_, _, default)), rows in zip(SLOTS.items(), items) if rows
    })


@routes.get("/api/gallery/{kind}")
async def browse(request):
    kind = request.match_info["kind"]
    rows = list((await catalog(request.app, kind)).values())
    query = request.query.get("q", "")[:100].strip().casefold().split()
    category = request.query.get("category", "")
    categories = sorted({row["category"] for row in rows if row["category"]})
    filtered = [row for row in rows if (not category or row["category"] == category)
                and all(word in row["search"] for word in query)]
    if request.query.get("random") == "1":
        if not filtered:
            raise ApiError(404, "没有找到素材")
        return web.json_response(public_item(kind, random.choice(filtered)))
    try:
        page = max(1, int(request.query.get("page", 1)))
    except ValueError:
        raise ApiError(400, "页码无效") from None
    offset = (page - 1) * 30
    return web.json_response({
        "items": [public_item(kind, item) for item in filtered[offset:offset + 30]],
        "categories": categories, "total": len(filtered), "page": page, "more": offset + 30 < len(filtered),
    })


@routes.get("/api/gallery/{kind}/thumb")
@routes.get("/api/gallery/{kind}/source")
async def gallery_asset(request):
    kind = request.match_info["kind"]
    item = (await catalog(request.app, kind)).get(request.query.get("id", ""))
    if not item or not await asyncio.to_thread(matches_package_source, item):
        raise ApiError(404, "素材不存在")
    full_size = request.path.endswith("/source")
    relative = item["full" if full_size else "thumb"]
    path = f"/ghil/{kind}/assets/{quote(relative, safe='/')}"
    async with request.app["client"].get(request.app["comfy"] + path) as response:
        if response.status != 200:
            raise ApiError(404, "图片无法读取")
        mimetype = "image/webp" if item["source"] and not full_size else IMAGE_TYPES.get(Path(relative).suffix.lower())
        return web.Response(body=await response.read(), content_type=mimetype or response.content_type,
                            headers={"Cache-Control": "private, max-age=3600"})


def save_upload(data, path):
    try:
        with Image.open(BytesIO(data), formats=["JPEG", "PNG", "WEBP"]) as source:
            if source.width * source.height > MAX_UPLOAD_PIXELS or getattr(source, "is_animated", False):
                raise ApiError(400, "请上传不超过 2000 万像素的静态图片")
            img = ImageOps.exif_transpose(source).convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ApiError(400, "请选择有效的 JPG、PNG 或 WebP 图片") from None
    img.thumbnail((2048, 2048))
    image = Image.alpha_composite(Image.new("RGBA", img.size, "white"), img).convert("RGB")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, "JPEG", quality=94)


@routes.post("/api/uploads")
async def upload(request):
    if request.content_type not in {"image/jpeg", "image/png", "image/webp", "application/octet-stream"}:
        raise ApiError(400, "请选择 JPG、PNG 或 WebP 图片")
    media_id = str(uuid4())
    path = UPLOADS / f"{media_id}.jpg"
    async with request.app["upload_limit"]:
        await asyncio.to_thread(save_upload, await request.read(), path)
    return web.json_response({"upload": media_id, "name": "已上传", "url": f"/api/uploads/{media_id}"}, status=201)


@routes.get("/api/uploads/{media_id:" + ID + "}")
async def show_upload(request):
    path = UPLOADS / f"{request.match_info['media_id']}.jpg"
    if not path.is_file():
        raise ApiError(404, "上传图片不存在")
    return web.FileResponse(path)


def make_prompt(model, selections, instruction, ratio, job_id):
    graph = deepcopy(TEMPLATES[model])
    for index, (kind, (node, label, _)) in enumerate(SLOTS.items(), 1):
        selection = selections.get(kind)
        if model == "h3-image" and not selection:
            # Match the H3 workflow's bypassed slots so prompt references are renumbered correctly.
            del graph[node]
            del graph[f"322:{410 + index}"]["inputs"]["Any"]
            del graph["322:404"]["inputs"][f"images.image_{index}"]
            continue
        graph[node]["inputs"] = {
            "image_type": ("上传" if "upload" in selection else label) if selection else "无",
            "image": (f"qwen-web/{selection['upload']}.jpg" if "upload" in selection else selection["id"])
                     if selection else "",
            "randomize": False,
        }
        if selection and "crop" in selection:
            inputs = graph[node]["inputs"]
            inputs["crop"] = json.dumps({
                "type": inputs["image_type"], "image": inputs["image"], "rect": selection["crop"],
            }, ensure_ascii=False)
    if model == "h3-image":
        graph["22"]["inputs"]["value"] = instruction
    else:
        graph["22"]["inputs"]["Text"] = instruction
        if not any(selections.get(kind) for kind in ("costume", "pose", "hair")):
            graph["322:305"]["inputs"]["用户提示词"] = ["22", 0]
        if ratio != "原始比例":
            graph["322:317"]["inputs"]["mode"] = "裁剪"
    graph["39"]["inputs"]["比例"] = ratio
    graph["249"]["inputs"]["seed"] = secrets.randbelow(1 << 50)
    graph["38"]["inputs"]["filename_prefix"] = f"QwenWeb/{job_id}/result"
    return graph


async def validate_selection(app, kind, choice):
    if not isinstance(choice, dict):
        raise ApiError(400, "素材格式无效")
    if "crop" in choice:
        rect = choice["crop"]
        if (not isinstance(rect, list) or len(rect) != 4
                or any(type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value) for value in rect)):
            raise ApiError(400, "裁剪范围无效")
        x, y, w, h = rect
        if w <= 0 or h <= 0 or x + w > 1.000000001 or y + h > 1.000000001:
            raise ApiError(400, "裁剪范围超出图片")
    keys = choice.keys() - {"crop"}
    if keys == {"id"} and isinstance(choice["id"], str):
        item = (await catalog(app, kind)).get(choice["id"])
        if item and await asyncio.to_thread(matches_package_source, item):
            return choice
    if keys == {"upload"} and isinstance(choice["upload"], str):
        if re.fullmatch(ID, choice["upload"]) and (UPLOADS / f"{choice['upload']}.jpg").is_file():
            return choice
    raise ApiError(400, f"{SLOTS[kind][1]}素材已失效，请重新选择")


async def random_selections(app, kind, count):
    candidates = list((await catalog(app, kind)).values())
    random.shuffle(candidates)
    selected = []
    for item in candidates:
        if await asyncio.to_thread(matches_package_source, item):
            selected.append({"id": item["id"]})
            if len(selected) == count:
                return selected
    if not selected:
        raise ApiError(400, f"{SLOTS[kind][1]}图库没有可用素材")
    return selected + random.choices(selected, k=count - len(selected))


async def enqueue(app, job, graph):
    job_id = job["id"]
    marker = JOBS / f"{job_id}.json"
    marker.write_text(json.dumps(job))
    try:
        result = await comfy(app, "/prompt", payload={
            "prompt_id": job_id, "client_id": job_id, "prompt": graph,
        })
    except ComfyError:
        marker.unlink(missing_ok=True)
        raise
    except (ClientError, TimeoutError):
        # The ID is fixed before submission, so polling can recover a lost reply.
        LOG.warning("ComfyUI submission reply lost for %s", job_id)
        return False
    if result.get("prompt_id") != job_id:
        marker.unlink(missing_ok=True)
        raise ApiError(502, "ComfyUI 返回了无效的任务编号")
    return True


@routes.post("/api/jobs")
async def submit(request):
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise ApiError(400, "任务参数无效") from None
    if not isinstance(body, dict):
        raise ApiError(400, "任务参数无效")
    model = body.get("model", "qwen")
    if not isinstance(model, str) or model not in TEMPLATES:
        raise ApiError(400, "请选择 Qwen 2.1 或 H3 Image")
    instruction = body.get("instruction", "")
    ratio = body.get("ratio", "原始比例")
    count = body.get("count", 1)
    randomize = body.get("randomize", [])
    refs = body.get("references")
    if type(count) is not int or not 1 <= count <= MAX_QUEUE:
        raise ApiError(400, f"生成数量必须为 1 至 {MAX_QUEUE} 张")
    if not isinstance(randomize, list) or len(randomize) > len(SLOTS) or any(
        not isinstance(kind, str) or kind not in SLOTS for kind in randomize
    ):
        raise ApiError(400, "随机素材类型无效")
    random_kinds = set(randomize)
    if not isinstance(instruction, str) or len(instruction) > 1200 or not isinstance(ratio, str) or ratio not in RATIOS:
        raise ApiError(400, "请检查画幅与补充提示词")
    if not isinstance(refs, dict) or refs.keys() - SLOTS.keys():
        raise ApiError(400, "素材格式无效")
    if "portrait" not in random_kinds and not refs.get("portrait"):
        raise ApiError(400, "请先选择人像")
    fixed = {kind: await validate_selection(request.app, kind, choice)
             for kind, choice in refs.items() if choice is not None and kind not in random_kinds}
    instruction = instruction.strip()
    if len(fixed.keys() | random_kinds) == 1 and not instruction:
        raise ApiError(400, "请选择一项造型素材，或填写补充提示词")
    picks = {kind: await random_selections(request.app, kind, count) for kind in SLOTS if kind in random_kinds}
    batch_id = str(uuid4()) if count > 1 else None
    jobs = []
    warning = None
    async with request.app["submit_lock"]:
        queue = await comfy(request.app, "/queue")
        if len(queue["queue_pending"]) + count > MAX_QUEUE:
            raise ApiError(429, "队列空间不足，请减少生成数量或稍后再试")
        created = int(time.time())
        for index in range(count):
            job_id = str(uuid4())
            job = {"id": job_id, "created": created, "model": model}
            if batch_id:
                job.update(batch=batch_id, position=index + 1)
            selections = {**fixed, **{kind: choices[index] for kind, choices in picks.items()}}
            graph = make_prompt(model, selections, instruction, ratio, job_id)
            try:
                confirmed = await enqueue(request.app, job, graph)
            except (ApiError, ComfyError) as exc:
                if not jobs:
                    raise
                LOG.warning("Batch %s stopped while submitting image %s: %s", batch_id, index + 1, exc)
                warning = f"已提交 {len(jobs)} 张，其余任务提交失败"
                break
            jobs.append({**job, "state": "queued"})
            if not confirmed and batch_id:
                warning = f"已发送 {len(jobs)} 张，最后一张等待确认"
                if len(jobs) < count:
                    warning += "，其余任务尚未提交"
                break
    return web.json_response({**jobs[0], "jobs": jobs, **({"warning": warning} if warning else {})}, status=202)


def web_job(request):
    job_id = request.match_info["job_id"]
    marker = JOBS / f"{job_id}.json"
    if not marker.is_file():
        raise ApiError(404, "任务不存在")
    job = json.loads(marker.read_text())
    job.setdefault("model", "qwen")
    return job


def output_path(job_id):
    return OUTPUTS / job_id / "result_00001_.png"


@routes.get("/api/jobs/{job_id:" + ID + "}")
async def job_status(request):
    job = web_job(request)
    job_id = job["id"]
    result = await comfy(request.app, f"/api/jobs/{job_id}", allow_missing=True)
    status = result.get("status") if result else None
    path = output_path(job_id)
    if status in {None, "completed"} and path.is_file():
        data = {"state": "success", "image": f"/api/jobs/{job_id}/image"}
    elif status in {"pending", "in_progress"}:
        data = {"state": "queued" if status == "pending" else "running"}
    elif status == "cancelled" or (status is None and job.get("cancelled")):
        data = {"state": "cancelled"}
    elif status == "failed":
        reason = result.get("execution_error") or {}
        LOG.info("Job %s failed: %s", job_id, str(reason)[:1000])
        message = "显存或内存不足，请减少参考图后重试" if "out of memory" in str(reason).lower() else "ComfyUI 生成失败，请重试"
        data = {"state": "error", "error": message}
    elif status is None and time.time() - job["created"] < 25:
        data = {"state": "queued"}
    else:
        data = {"state": "error", "error": "任务已结束，但没有生成图片"}
    return web.json_response({**job, **data})


@routes.post("/api/jobs/{job_id:" + ID + "}/cancel")
async def cancel(request):
    job = web_job(request)
    result = await comfy(request.app, f"/api/jobs/{job['id']}/cancel", payload={})
    if result.get("cancelled"):
        # ComfyUI removes pending jobs without writing a history entry.
        marker = JOBS / f"{job['id']}.json"
        job["cancelled"] = True
        temporary = marker.with_suffix(".tmp")
        temporary.write_text(json.dumps(job))
        temporary.replace(marker)
    return web.json_response({"cancelled": bool(result.get("cancelled"))})


@routes.get("/api/jobs/{job_id:" + ID + "}/image")
async def job_image(request):
    job = web_job(request)
    path = output_path(job["id"])
    if not path.is_file():
        raise ApiError(404, "结果尚未生成")
    headers = {}
    if request.query.get("download") == "1":
        prefix = "H3-Image" if job["model"] == "h3-image" else "Qwen"
        headers["Content-Disposition"] = f'attachment; filename="{prefix}-{job["id"][:8]}.png"'
    return web.FileResponse(path, headers=headers)


async def resources(app):
    async with ClientSession(timeout=ClientTimeout(total=25)) as client:
        app["client"] = client
        yield


def create_app(comfy_url):
    JOBS.mkdir(parents=True, exist_ok=True)
    app = web.Application(middlewares=[respond], client_max_size=MAX_UPLOAD)
    app.update({
        "comfy": comfy_url, "catalog": {}, "original_custom": original_custom_assets(),
        "catalog_locks": {kind: asyncio.Lock() for kind in SLOTS},
        "submit_lock": asyncio.Lock(), "upload_limit": asyncio.Semaphore(2),
    })
    app.cleanup_ctx.append(resources)
    app.add_routes(routes)
    for name in ("app.js", "crop.js", "style.css", "favicon.svg"):
        async def static(request, filename=name):
            return web.FileResponse(SITE / filename)
        app.router.add_get("/" + name, static)
    async def example(request):
        return web.FileResponse(SITE / "assets" / "example.webp", headers={"Content-Type": "image/webp"})

    app.router.add_get("/assets/example.webp", example)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="造型工作台")
    parser.add_argument("--host", action="append", help="监听地址，可重复指定")
    parser.add_argument("--port", type=int, default=8190)
    parser.add_argument("--comfy", default="http://127.0.0.1:8188")
    args = parser.parse_args()
    upstream = urlsplit(args.comfy)
    if upstream.scheme != "http" or upstream.hostname not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("--comfy 必须指向本机 HTTP 服务")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    web.run_app(create_app(args.comfy.rstrip("/")), host=args.host or ["127.0.0.1"], port=args.port)
