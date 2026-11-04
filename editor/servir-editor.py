"""Serve o editor OSM e grava patches no mesmo arquivo que o OrthoForge lê."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import importlib.util
import json
import os
import re
import shutil
import threading
import webbrowser

APP_ROOT = Path(__file__).resolve().parent
PROJETO = APP_ROOT.parent
OSM_DIR = PROJETO / "osm"
CONFIG_PATH = PROJETO / "config.json"
PASTA_PADRAO = r"D:\SteamLibrary\steamapps\common\X-Plane 12\XPlane Map Enhancement Data"
PORT = 8767
JOB = {"running": False, "lines": []}
JOB_LOCK = threading.Lock()
CONFIG_PATH = APP_ROOT / "editor-config.json"
DEFAULT_NAME = "SBSP4.patch.osm"

TILE_FOLDER_RE = re.compile(r"^([+-]?\d{2})([+-]\d{3})$")


def load_config():
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg):
    CONFIG_PATH.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def steam_libraries():
    roots = [
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Steam",
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Steam",
        Path(r"D:\SteamLibrary"),
        Path(r"E:\SteamLibrary"),
        Path(r"F:\SteamLibrary"),
    ]
    seen = set()
    out = []
    for root in roots:
        if not root.exists():
            continue
        key = str(root.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(root)
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if not vdf.exists():
            continue
        text = vdf.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r'"path"\s+"([^"]+)"', text):
            lib = Path(m.group(1).replace("\\\\", "\\"))
            k2 = str(lib).lower()
            if k2 in seen or not lib.exists():
                continue
            seen.add(k2)
            out.append(lib)
    return out


def detect_patches_dir(cfg):
    env = os.environ.get("ORTHOFORGE_PATCHES", "").strip()
    candidates = []
    if cfg.get("patches_dir"):
        candidates.append(Path(cfg["patches_dir"]))
    if env:
        candidates.append(Path(env))
    for lib in steam_libraries():
        candidates.append(lib / "steamapps" / "common" / "X-Plane 12" / "OrthoForge" / "Patches")
    candidates.extend([
        Path(r"D:\SteamLibrary\steamapps\common\X-Plane 12\OrthoForge\Patches"),
        Path(r"C:\Program Files (x86)\Steam\steamapps\common\X-Plane 12\OrthoForge\Patches"),
        APP_ROOT.parent / "OrthoForge" / "Patches",
    ])
    for path in candidates:
        try:
            if path.is_dir():
                return path.resolve()
        except Exception:
            continue
    return APP_ROOT


def tile_from_rel(rel):
    parts = Path(rel).parts
    for part in reversed(parts[:-1] if len(parts) > 1 else parts):
        m = TILE_FOLDER_RE.fullmatch(part)
        if m:
            return {"lat": int(m.group(1)), "lon": int(m.group(2))}
    return {"lat": -24, "lon": -47}


def rel_posix(path, root):
    return path.resolve().relative_to(root.resolve()).as_posix()


def list_osm(root):
    files = []
    for path in sorted(root.rglob("*.osm")):
        if not path.is_file():
            continue
        if path.name.startswith("."):
            continue
        if path.suffixes[-2:] == [".osm", ".bak"] or path.name.endswith(".osm.bak"):
            continue
        rel = rel_posix(path, root)
        tile = tile_from_rel(rel)
        files.append({
            "path": rel,
            "name": path.name,
            "abs": str(path),
            "tile": tile,
            "tile_label": "%+03d / %+04d" % (tile["lat"], tile["lon"]),
        })
    return files


def safe_osm_path(rel, root):
    if not rel:
        return None
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel.lower().endswith(".osm"):
        return None
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    if ".." in Path(rel).parts:
        return None
    return candidate


def ler_pasta():
    if CONFIG_PATH.is_file():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if data.get("pasta"):
                return data["pasta"]
        except (OSError, ValueError):
            pass
    return PASTA_PADRAO


def gravar_pasta(pasta):
    CONFIG_PATH.write_text(
        json.dumps({"pasta": pasta}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def nomes_osm():
    OSM_DIR.mkdir(parents=True, exist_ok=True)
    return sorted(p.name for p in OSM_DIR.glob("*.osm"))


def compilador():
    path = PROJETO / "compilador" / "aplicar_terreno.pyw"
    spec = importlib.util.spec_from_file_location("terreno", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def job_log(line):
    with JOB_LOCK:
        JOB["lines"].append(str(line))
        del JOB["lines"][:-400]


def job_run(nomes, acao):
    with JOB_LOCK:
        if JOB["running"]:
            return False
        JOB["running"] = True
        JOB["lines"] = []
    def trabalho():
        try:
            mod = compilador()
            pasta = ler_pasta()
            for nome in nomes:
                job_log(nome)
                caminho = OSM_DIR / nome
                if acao == "compilar":
                    mod.aplicar(pasta, str(caminho), job_log)
                else:
                    mod.recuperar(pasta, str(caminho), job_log)
            job_log("pronto")
        except Exception as exc:
            job_log("erro: " + str(exc))
        finally:
            with JOB_LOCK:
                JOB["running"] = False
    threading.Thread(target=trabalho, daemon=True).start()
    return True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_ROOT), **kwargs)

    def end_headers(self):
        path = urlparse(self.path).path
        if path.endswith((".html", ".js", ".css", ".osm", ".xml", ".json")):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, code, data, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)
        if route == "/api/meta":
            cfg = load_config()
            root = detect_patches_dir(cfg)
            files = list_osm(root)
            last = cfg.get("last_file")
            names = {f["path"] for f in files}
            default = last if last in names else None
            if not default:
                for f in files:
                    if f["name"] == DEFAULT_NAME:
                        default = f["path"]
                        break
            if not default and files:
                default = files[0]["path"]
            picked = next((f for f in files if f["path"] == default), None)
            self._json(200, {
                "patches_dir": str(root),
                "files": files,
                "default": default or DEFAULT_NAME,
                "tile": (picked or {}).get("tile") or tile_from_rel(default or ""),
                "using_app_folder": root.resolve() == APP_ROOT.resolve(),
            })
            return
        if route == "/api/projeto":
            with JOB_LOCK:
                log = list(JOB["lines"])
                running = JOB["running"]
            self._json(200, {
                "pasta": ler_pasta(),
                "arquivos": nomes_osm(),
                "running": running,
                "log": log,
            })
            return
        if route == "/api/export":
            nome = (qs.get("name") or [""])[0]
            path = safe_osm_path(nome, OSM_DIR)
            if not path or not path.is_file():
                self.send_error(404, "OSM não encontrado")
                return
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Disposition", "attachment; filename=\"%s\"" % path.name)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if route == "/api/osm":
            cfg = load_config()
            root = detect_patches_dir(cfg)
            rel = (qs.get("path") or [cfg.get("last_file") or DEFAULT_NAME])[0]
            path = safe_osm_path(rel, root)
            if not path or not path.is_file():
                self.send_error(404, "Patch OSM não encontrado")
                return
            data = path.read_bytes()
            cfg["patches_dir"] = str(root)
            cfg["last_file"] = rel_posix(path, root)
            save_config(cfg)
            self._bytes(200, data, "application/xml; charset=utf-8")
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)
        length = int(self.headers.get("Content-Length", "0"))
        if length > 40_000_000:
            self.send_error(413, "Arquivo grande demais")
            return
        body = self.rfile.read(length) if length else b""

        if route == "/api/projeto":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except Exception:
                self.send_error(400, "JSON inválido")
                return
            if payload.get("pasta"):
                pasta = payload["pasta"]
                if not os.path.isdir(pasta):
                    self._json(400, {"ok": False, "error": "Pasta inexistente"})
                    return
                gravar_pasta(pasta)
            acao = payload.get("acao")
            nomes = [n for n in payload.get("nomes") or [] if n.lower().endswith(".osm")]
            if acao in ("compilar", "recuperar"):
                if not nomes:
                    self._json(400, {"ok": False, "error": "Marque um OSM"})
                    return
                if not job_run(nomes, acao):
                    self._json(409, {"ok": False, "error": "Já existe uma compilação em andamento"})
                    return
            if acao == "apagar":
                for nome in nomes:
                    path = safe_osm_path(nome, OSM_DIR)
                    if path and path.is_file():
                        path.unlink()
            self._json(200, {"ok": True, "pasta": ler_pasta(), "arquivos": nomes_osm()})
            return

        if route == "/api/import":
            nome = os.path.basename((qs.get("name") or ["importado.osm"])[0])
            if not nome.lower().endswith(".osm"):
                self.send_error(400, "O arquivo precisa ser .osm")
                return
            if b"<osm" not in body.lstrip()[:800]:
                self.send_error(400, "XML OSM inválido")
                return
            OSM_DIR.mkdir(parents=True, exist_ok=True)
            destino = OSM_DIR / nome
            if destino.exists():
                shutil.copy2(destino, destino.with_suffix(destino.suffix + ".bak"))
            destino.write_bytes(body)
            self._json(200, {"ok": True, "file": nome})
            return

        if route == "/api/config":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except Exception:
                self.send_error(400, "JSON inválido")
                return
            cfg = load_config()
            if payload.get("patches_dir"):
                folder = Path(payload["patches_dir"])
                if not folder.is_dir():
                    self._json(400, {"ok": False, "error": "Pasta inexistente"})
                    return
                cfg["patches_dir"] = str(folder.resolve())
            if payload.get("last_file"):
                cfg["last_file"] = payload["last_file"]
            save_config(cfg)
            self._json(200, {"ok": True, "config": cfg})
            return

        if route != "/save":
            self.send_error(404)
            return
        cfg = load_config()
        root = detect_patches_dir(cfg)
        rel = (qs.get("path") or qs.get("name") or [cfg.get("last_file") or DEFAULT_NAME])[0]
        path = safe_osm_path(rel, root)
        if not path:
            self.send_error(400, "Caminho OSM inválido")
            return
        head = body.lstrip()[:800]
        if b"<osm" not in head:
            self.send_error(400, "XML OSM inválido")
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            path.with_suffix(path.suffix + ".bak").write_bytes(path.read_bytes())
        path.write_bytes(body)
        rel = rel_posix(path, root)
        cfg["patches_dir"] = str(root)
        cfg["last_file"] = rel
        save_config(cfg)
        self._json(200, {"ok": True, "file": rel, "abs": str(path), "bytes": len(body)})

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


_httpd = None


def garantir_servidor():
    """Sobe o editor neste processo, sem abrir o navegador. Devolve a URL."""
    global _httpd
    cfg = load_config()
    patches = OSM_DIR if OSM_DIR.is_dir() else detect_patches_dir(cfg)
    cfg["patches_dir"] = str(patches)
    save_config(cfg)
    url = "http://127.0.0.1:%s/editor.html" % PORT
    if _httpd is not None:
        return url
    try:
        _httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        return url
    threading.Thread(target=_httpd.serve_forever, daemon=True).start()
    return url


if __name__ == "__main__":
    cfg = load_config()
    patches = detect_patches_dir(cfg)
    cfg["patches_dir"] = str(patches)
    save_config(cfg)
    url = "http://127.0.0.1:%s/editor.html" % PORT
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        print("A interface já está aberta em %s" % url, flush=True)
        print(exc, flush=True)
        webbrowser.open(url)
        raise SystemExit(0)
    print("Editor OSM: %s" % url, flush=True)
    print("Patches:    %s" % patches, flush=True)
    if patches.resolve() == APP_ROOT.resolve():
        print("AVISO: pasta Patches do OrthoForge não encontrada. Gravando nesta pasta.", flush=True)
    print("Ctrl+S grava o mesmo arquivo que o Step 1 lê.", flush=True)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    httpd.serve_forever()
