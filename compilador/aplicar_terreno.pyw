"""Edita o terreno do Map Enhancement com as altitudes de um .patch.osm.

A grade original tem cerca de 90 m e nao acompanha o contorno do aeroporto.
O programa refina essa grade e pinta cada celula que o poligono do OSM toca.
"""
import hashlib
import importlib.util
import json
import math
import os
import shutil
import socket
import sys
import struct
import subprocess
import tempfile
import threading
import time
import multiprocessing
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, ThreadPoolExecutor, wait
import tkinter as tk
import webbrowser
import xml.etree.ElementTree as ET
from math import cos, hypot, radians, tanh
from tkinter import filedialog, messagebox, ttk

import numpy
import triangle
from collections import defaultdict

from shapely.geometry import GeometryCollection, LineString, MultiPoint, MultiPolygon, Point, Polygon, box
from shapely import constrained_delaunay_triangles, get_coordinates
from shapely.ops import polygonize, snap, unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

M_LAT = 110540.0
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
cancelar = threading.Event()
_proc_trava = threading.Lock()
_proc_atual = None
_evento_processos = None
_checagens = 0
_triangle_trava = threading.Lock()


class Cancelado(Exception):
    pass


def verificar_cancelamento():
    """Chamada dentro dos laços. Só consulta o aviso a cada 500 vezes, porque entre processos ele custa caro."""
    global _checagens
    _checagens += 1
    if _checagens % 500 == 0 and cancelar.is_set():
        raise Cancelado()


def pedir_cancelamento():
    cancelar.set()
    if _evento_processos is not None:
        _evento_processos.set()
    with _proc_trava:
        proc = _proc_atual
    if proc is not None and proc.poll() is None:
        proc.kill()


def run_quiet(args, cwd=None):
    if cancelar.is_set():
        raise Cancelado()
    kwargs = {"cwd": cwd, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        info = subprocess.STARTUPINFO()
        info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        info.wShowWindow = subprocess.SW_HIDE
        kwargs["startupinfo"] = info
        kwargs["creationflags"] = NO_WINDOW | subprocess.DETACHED_PROCESS
    proc = subprocess.Popen(args, **kwargs)
    global _proc_atual
    with _proc_trava:
        _proc_atual = proc
    try:
        while True:
            try:
                code = proc.wait(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                if cancelar.is_set():
                    proc.kill()
                    proc.wait()
                    raise Cancelado()
    finally:
        with _proc_trava:
            if _proc_atual is proc:
                _proc_atual = None
    if cancelar.is_set():
        raise Cancelado()
    if code != 0:
        raise subprocess.CalledProcessError(code, args)


def seven_zip():
    here = os.path.dirname(os.path.abspath(__file__))
    nome = "7z.exe" if os.name == "nt" else "7z"
    pasta = "win" if os.name == "nt" else "lin"
    candidatos = [
        os.path.join(here, "..", "ferramentas", pasta, nome),
        os.path.join(here, nome),
        shutil.which(nome) or "",
        shutil.which("7zz") or "",
    ]
    if os.name == "nt":
        candidatos += [
            r"C:\Program Files\7-Zip\7z.exe",
            r"C:\Program Files (x86)\7-Zip\7z.exe",
        ]
    for path in candidatos:
        if path and os.path.isfile(path):
            return path
    raise FileNotFoundError("7z nao encontrado. Instale o 7-Zip.")


def dist_m(a, b, m_lon):
    return hypot((a[0] - b[0]) * m_lon, (a[1] - b[1]) * M_LAT)


def segment_distance(point, a, b, m_lon):
    vx, vy = (b[0] - a[0]) * m_lon, (b[1] - a[1]) * M_LAT
    den = vx * vx + vy * vy
    if den == 0:
        return dist_m(point, a, m_lon)
    px, py = (point[0] - a[0]) * m_lon, (point[1] - a[1]) * M_LAT
    t = max(0.0, min(1.0, (px * vx + py * vy) / den))
    return dist_m(point, (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])), m_lon)


def profile_of(name, steepness):
    if name and "tanh" in name:
        def tanh_profile(x):
            return (tanh((x - 0.5) * steepness) / tanh(0.5 * steepness) + 1) / 2
        return tanh_profile
    if name == "spline":
        return lambda x: 3 * x * x - 2 * x * x * x
    return lambda x: x


def load_patch(path):
    root = ET.parse(path).getroot()
    nodes = {
        n.get("id"): (float(n.get("lon")), float(n.get("lat")))
        for n in root.findall("node")
    }
    flats, ramps = [], []
    lons, lats = [], []
    for way in root.findall("way"):
        refs = [nd.get("ref") for nd in way.findall("nd")]
        tags = {t.get("k"): t.get("v") for t in way.findall("tag")}
        if len(refs) < 4 or refs[0] != refs[-1]:
            continue
        ring = [nodes[r] for r in refs]
        lons.extend(p[0] for p in ring)
        lats.extend(p[1] for p in ring)
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.is_empty:
            polygon = polygon.buffer(0)
        if polygon.is_empty:
            continue
        if "altitude" in tags:
            flats.append((polygon, float(tags["altitude"])))
        elif "altitude_high" in tags and len(refs) == 5:
            steep = float(tags.get("steepness", "2"))
            ramps.append(
                (
                    polygon,
                    ring[0],
                    ring[3],
                    ring[1],
                    ring[2],
                    float(tags["altitude_high"]),
                    float(tags["altitude_low"]),
                    profile_of(tags.get("profile"), steep),
                )
            )
    if not lons:
        raise ValueError("o OSM nao tem poligonos de altitude")
    return flats, ramps, (min(lons), min(lats), max(lons), max(lats))


def find_dsfs(folder):
    found = []
    for dirpath, dirnames, filenames in os.walk(folder):
        dirnames[:] = [d for d in dirnames if d not in ("_textures", "textures", "terrain")]
        if os.path.basename(dirpath).lower() != "earth nav data" and "earth nav data" not in dirpath.lower():
            continue
        for name in filenames:
            if name.endswith(".dsf") and name[0] in "+-" and not name.endswith(".bak"):
                found.append(os.path.join(dirpath, name))
    return found


def tile_of(path):
    name = os.path.splitext(os.path.basename(path))[0]
    # File name is the southwest corner, for example -24-047.
    return int(name[:3]), int(name[3:])


def read_props(data):
    props = {}
    off = 12
    end = len(data) - 16
    while off + 8 <= end:
        aid = data[off : off + 4][::-1].decode("ascii", "replace")
        length = struct.unpack_from("<I", data, off + 4)[0]
        if aid == "PROP":
            blob = data[off + 8 : off + length]
            parts = blob.split(b"\x00")
            for i in range(0, len(parts) - 1, 2):
                key = parts[i].decode("ascii", "replace")
                val = parts[i + 1].decode("ascii", "replace")
                if key:
                    props[key] = val
            return props
        if length < 8:
            break
        off += length
    return props


def load_dsf(path, work):
    with open(path, "rb") as handle:
        magic = handle.read(2)
    raw = os.path.join(work, os.path.basename(path) + ".raw")
    if os.path.isfile(raw):
        os.remove(raw)
    if magic == b"7z":
        run_quiet([seven_zip(), "e", "-y", "-o" + work, path])
        wanted = os.path.basename(path)
        if wanted.endswith(".antes_osm"):
            wanted = wanted[: -len(".antes_osm")]
        inner = os.path.join(work, wanted)
        if not os.path.isfile(inner):
            found = [name for name in os.listdir(work) if name.lower().endswith(".dsf")]
            if len(found) != 1:
                raise RuntimeError("o 7z nao continha o DSF")
            inner = os.path.join(work, found[0])
        return inner, True
    shutil.copy2(path, raw)
    return raw, False


def store_dsf(src_raw, dest, compressed):
    data_check = open(src_raw, "rb").read(8)
    if data_check != b"XPLNEDSF":
        raise RuntimeError("DSF invalido depois da edicao")
    if not compressed:
        shutil.copy2(src_raw, dest)
        return
    folder = os.path.dirname(src_raw)
    archive = dest + ".tmp.7z"
    if os.path.isfile(archive):
        os.remove(archive)
    run_quiet(
        [seven_zip(), "a", "-t7z", "-m0=LZMA", "-mx=5", "-md=48m", archive, "--", os.path.basename(src_raw)],
        cwd=folder,
    )
    os.replace(archive, dest)


def layers_of(flats, ramps):
    layers = [(poly, ("flat", alt)) for poly, alt in flats]
    layers += [
        (poly, ("ramp", h0, h1, l0, l1, high, low, profile))
        for poly, h0, h1, l0, l1, high, low, profile in ramps
    ]
    return layers


def dsf_tool():
    here = os.path.dirname(os.path.abspath(__file__))
    if sys.platform == "darwin":
        pasta, nome = "mac", "DSFTool"
    elif sys.platform.startswith("linux"):
        pasta, nome = "lin", "DSFTool"
    else:
        pasta, nome = "win", "DSFTool.exe"
    path = os.path.normpath(os.path.join(here, "..", "ferramentas", pasta, "tools", nome))
    if not os.path.isfile(path):
        raise FileNotFoundError("DSFTool nao encontrado em ferramentas/%s/tools" % pasta)
    return path


BLEND_M = 70.0
SEA_M = 0.0


def spec_height(lon, lat, spec, m_lon):
    if spec[0] == "flat":
        return spec[1]
    _, h0, h1, l0, l1, high, low, profile = spec
    d_high = segment_distance((lon, lat), h0, h1, m_lon)
    d_low = segment_distance((lon, lat), l0, l1, m_lon)
    span = d_high + d_low
    t = 0.0 if span == 0 else d_high / span
    return high - profile(t) * (high - low)


def altitude_at(lon, lat, layers, m_lon):
    """Altitude do OSM no ponto. None quando o ponto fica fora de todo poligono."""
    height_m = None
    point = Point(lon, lat)
    for polygon, spec in layers:
        if not polygon.covers(point):
            continue
        height_m = spec_height(lon, lat, spec, m_lon)
    return height_m


def height_on_mesh(lon, lat, layers, m_lon, dem_z, proteger_agua=True, blend_m=BLEND_M):
    """Dentro do polígono usa o OSM. Na faixa escolhida desce liso até o terreno.

    Dentro do polígono a altitude do OSM vale mesmo abaixo do mar.
    Fora dele, o mar fica com a malha original.
    """
    inside = altitude_at(lon, lat, layers, m_lon)
    if inside is not None:
        return inside
    if proteger_agua and dem_z <= SEA_M:
        return None
    point = Point(lon, lat)
    nearest = None
    nearest_m = None
    for polygon, spec in layers:
        dist_m = polygon.distance(point) * 111320.0
        if nearest_m is None or dist_m < nearest_m:
            nearest_m = dist_m
            nearest = (polygon, spec)
    if nearest is None or nearest_m is None or blend_m <= 0 or nearest_m >= blend_m:
        return dem_z
    border = nearest[0].exterior.interpolate(nearest[0].exterior.project(point))
    edge_z = spec_height(border.x, border.y, nearest[1], m_lon)
    t = nearest_m / blend_m
    t = t * t * (3.0 - 2.0 * t)
    return edge_z * (1.0 - t) + dem_z * t


def sample_dem(grid, west, south, lon, lat):
    height, width = grid.shape
    row = (lat - south) * (height - 1)
    col = (lon - west) * (width - 1)
    row = min(max(row, 0), height - 1)
    col = min(max(col, 0), width - 1)
    r0 = int(row)
    c0 = int(col)
    r1 = min(r0 + 1, height - 1)
    c1 = min(c0 + 1, width - 1)
    fr = row - r0
    fc = col - c0
    value = (
        grid[r0, c0] * (1 - fr) * (1 - fc)
        + grid[r0, c1] * (1 - fr) * fc
        + grid[r1, c0] * fr * (1 - fc)
        + grid[r1, c1] * fr * fc
    )
    return float(value)


def barycentric(point, a, b, c):
    den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(den) < 1e-18:
        return (1.0, 0.0, 0.0)
    w0 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / den
    w1 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / den
    w2 = 1.0 - w0 - w1
    return (w0, w1, w2)


def surface_parts(geom):
    if geom.is_empty:
        return
    kind = geom.geom_type
    if kind == "Polygon":
        if geom.area > 1e-14:
            yield geom
    elif kind in ("MultiPolygon", "GeometryCollection"):
        for part in geom.geoms:
            yield from surface_parts(part)


def clip_polygons(layers, region):
    """Contorno de cada polígono e uma única borda externa da faixa."""
    clips = [polygon for polygon, _spec in layers]
    if not region.is_empty:
        clips.append(region)
    return clips


def cut_triangle(verts, clips, region, quality=False):
    """Divide um triângulo nas bordas do OSM. Cada vértice é (lon, lat, extras)."""
    corners = [(v[0], v[1]) for v in verts]
    if corners[0] == corners[1] or corners[1] == corners[2] or corners[0] == corners[2]:
        return [verts]
    tri = Polygon(corners)
    if tri.is_empty or not tri.is_valid:
        tri = tri.buffer(0)
    if tri.is_empty or not region.intersects(tri):
        return [verts]
    touch = []
    for polygon in clips:
        if polygon.intersects(tri):
            touch.extend(get_coordinates(tri.exterior.intersection(polygon.boundary)).tolist())
    extra = [p for p in touch if min(hypot(p[0] - c[0], p[1] - c[1]) for c in corners) > 1e-11]
    if extra:
        tri = snap(tri, MultiPoint(extra), 1e-11)
    pieces = [tri]
    for polygon in clips:
        nxt = []
        for piece in pieces:
            if piece.is_empty or not piece.intersects(polygon):
                nxt.append(piece)
                continue
            nxt.extend(surface_parts(piece.intersection(polygon)))
            nxt.extend(surface_parts(piece.difference(polygon)))
        pieces = nxt
    if not extra and len(pieces) == 1 and abs(pieces[0].area - tri.area) <= tri.area * 1e-9:
        return [verts]
    origin = signed_area(corners[0], corners[1], corners[2])
    made = []
    for piece in pieces:
        smalls = triangulate_face(piece) if quality else surface_parts(constrained_delaunay_triangles(piece))
        for small in smalls:
            if small.area <= 1e-16:
                continue
            ring = list(small.exterior.coords)[:3]
            if origin * signed_area(ring[0], ring[1], ring[2]) < 0:
                ring = [ring[0], ring[2], ring[1]]
            made.append(tuple(interpolate_vertex(point, verts) for point in ring))
    return made or [verts]


def signed_area(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def interpolate_vertex(point, verts):
    weights = barycentric(point, verts[0], verts[1], verts[2])
    extras = []
    width = len(verts[0]) - 2
    for index in range(width):
        extras.append(sum(weights[n] * verts[n][2 + index] for n in range(3)))
    return (point[0], point[1], *extras)


def format_vertex(vertex, z_value):
    lon, lat = vertex[0], vertex[1]
    tail = " ".join("%.9f" % value for value in vertex[3:])
    return "PATCH_VERTEX %.9f %.9f %.3f %s\n" % (lon, lat, z_value, tail)


def vertex_key(vertex):
    return (round(vertex[0], 8), round(vertex[1], 8))


def edge_key(a, b):
    ka = vertex_key(a)
    kb = vertex_key(b)
    return (ka, kb) if ka <= kb else (kb, ka)


def read_batches(src):
    """Gera (linha, lote) para cada linha do texto do DSF. O lote vem no END_PRIMITIVE."""
    primitive = False
    batch = []
    with open(src, "r", encoding="utf-8", errors="ignore") as fin:
        for line in fin:
            if line.startswith("BEGIN_PRIMITIVE"):
                primitive = True
                batch = []
                yield line, None
                continue
            if line.startswith("END_PRIMITIVE"):
                primitive = False
                yield line, batch
                continue
            if primitive and line.startswith("PATCH_VERTEX"):
                batch.append(tuple(float(item) for item in line.split()[1:]))
                continue
            yield line, None


def flat_level(tri):
    """Altura comum dos três vértices, em milímetros. None quando o triângulo inclina."""
    z = tri[0][2]
    if abs(tri[1][2] - z) > 1e-3 or abs(tri[2][2] - z) > 1e-3:
        return None
    return int(round(z * 1000.0))


def merge_flat(tris):
    """Junta os pedaços que estão na mesma altura. A borda de cada grupo fica igual."""
    groups = defaultdict(list)
    out = []
    for tri in tris:
        level = flat_level(tri)
        if level is None:
            out.append(tri)
        else:
            groups[level].append(tri)
    for group in groups.values():
        if len(group) < 3:
            out.extend(group)
            continue
        out.extend(merge_group(group))
    return out


MIN_ANGLE = 25


def cdt_parts(shape):
    return list(surface_parts(constrained_delaunay_triangles(shape)))


def quality_parts(face):
    """Triangle (Shewchuk) sem ponto novo na borda e sem limite de tamanho. Só cria ponto no meio para evitar ângulo fechado."""
    ox, oy = face.bounds[0], face.bounds[1]
    m_lon = 111320.0 * cos(radians(oy))
    vertices = []
    segments = []
    holes = []
    for index, ring in enumerate([face.exterior, *face.interiors]):
        coords = list(ring.coords)[:-1]
        clean = []
        for x, y in coords:
            if not clean or (x, y) != clean[-1]:
                clean.append((x, y))
        if len(clean) > 1 and clean[0] == clean[-1]:
            clean.pop()
        if len(clean) < 3:
            return None
        start = len(vertices)
        for x, y in clean:
            vertices.append(((x - ox) * m_lon, (y - oy) * 111320.0))
        for n in range(len(clean)):
            segments.append((start + n, start + (n + 1) % len(clean)))
        if index > 0:
            inside = Polygon(ring).representative_point()
            holes.append(((inside.x - ox) * m_lon, (inside.y - oy) * 111320.0))
    data = {"vertices": vertices, "segments": segments}
    if holes:
        data["holes"] = holes
    try:
        with _triangle_trava:
            result = triangle.triangulate(data, "pq%dYQ" % MIN_ANGLE)
    except Exception:
        return None
    if "triangles" not in result:
        return None
    pts = [(ox + x / m_lon, oy + y / 111320.0) for x, y in result["vertices"]]
    lookup = {
        (round(x, 8), round(y, 8)): (x, y)
        for ring in [face.exterior, *face.interiors]
        for x, y in ring.coords
    }
    pts = [lookup.get((round(x, 8), round(y, 8)), (x, y)) for x, y in pts]
    return [Polygon([pts[a], pts[b], pts[c]]) for a, b, c in result["triangles"]]


def triangulate_face(face):
    pieces = quality_parts(face)
    if pieces:
        total = sum(piece.area for piece in pieces)
        if abs(total - face.area) <= face.area * 1e-6:
            return pieces
    return cdt_parts(face)


def merge_group(group):
    points = {}
    counts = defaultdict(int)
    for tri in group:
        for vertex in tri:
            points[vertex_key(vertex)] = vertex
        for n in range(3):
            counts[edge_key(tri[n], tri[(n + 1) % 3])] += 1
    border = [LineString([a, b]) for (a, b), used in counts.items() if used == 1]
    if not border:
        return group
    shapes = [Polygon([(v[0], v[1]) for v in tri]) for tri in group]
    area = unary_union(shapes)
    inside = prep(area.buffer(1e-10))
    tree = STRtree(shapes)
    sign = signed_area(group[0][0], group[0][1], group[0][2])
    level = group[0][0][2]

    def locate(x, y):
        for index in tree.query(Point(x, y), predicate="intersects"):
            base = group[int(index)]
            made_vertex = interpolate_vertex((x, y), base)
            return (made_vertex[0], made_vertex[1], level, *made_vertex[3:])
        return None

    made = []
    for face in polygonize(unary_union(border)):
        if face.area <= 0 or not inside.covers(face.representative_point()):
            continue
        for small in triangulate_face(face):
            ring = list(small.exterior.coords)[:3]
            keys = [(round(x, 8), round(y, 8)) for x, y in ring]
            for key, (x, y) in zip(keys, ring):
                if key not in points:
                    found = locate(x, y)
                    if found is None:
                        return group
                    points[key] = found
            tri = [points[key] for key in keys]
            if sign * signed_area(tri[0], tri[1], tri[2]) < 0:
                tri = [tri[0], tri[2], tri[1]]
            made.append(tuple(tri))
    if not made:
        return group
    total = sum(abs(signed_area(t[0], t[1], t[2])) for t in made)
    if abs(total - area.area * 2.0) > area.area * 2e-4:
        return group
    return made


SNAP_M = 1.5


def mesh_points_near(src, bounds, pad):
    """Vértices da malha original dentro da caixa, sem repetir."""
    minx, miny, maxx, maxy = bounds
    seen = set()
    for _line, batch in read_batches(src):
        if batch is None:
            continue
        for vertex in batch:
            if minx - pad <= vertex[0] <= maxx + pad and miny - pad <= vertex[1] <= maxy + pad:
                seen.add((vertex[0], vertex[1]))
    return list(seen)


def snap_to_mesh(shape, tree, points, tol):
    """Encaixa o contorno nos vértices da malha a até tol. Devolve o original se o encaixe estragar a forma."""
    near = tree.query(shape.boundary.buffer(tol))
    if len(near) == 0:
        return shape
    ref = MultiPoint([points[int(index)] for index in near])
    moved = snap(shape, ref, tol)
    if not moved.is_valid:
        moved = moved.buffer(0)
    if moved.is_empty or abs(moved.area - shape.area) > shape.area * 0.01:
        return shape
    return moved


def snap_layers(src, layers, blend_m, log):
    """Contornos dos polígonos e da faixa encaixados nos vértices da malha a até SNAP_M."""
    tol = SNAP_M / 111320.0
    union = unary_union([polygon for polygon, _spec in layers])
    bounds = union.buffer(blend_m / 111320.0).bounds
    points = mesh_points_near(src, bounds, 0.002)
    if not points:
        return layers, union.buffer(blend_m / 111320.0)
    tree = STRtree([Point(p) for p in points])
    snapped = [(snap_to_mesh(polygon, tree, points, tol), spec) for polygon, spec in layers]
    region = unary_union([polygon for polygon, _spec in snapped]).buffer(blend_m / 111320.0)
    region = snap_to_mesh(region, tree, points, tol)
    log("contornos encaixados na malha (ate %.1f m)" % SNAP_M)
    return snapped, region


def cut_mesh_text(src, dst, layers, grid, west, south, log, proteger_agua=True, blend_m=BLEND_M, otimizar=False, melhorar=False):
    if melhorar:
        layers, region = snap_layers(src, layers, blend_m, log)
    else:
        region = unary_union([polygon for polygon, _spec in layers]).buffer(blend_m / 111320.0)
    minx, miny, maxx, maxy = region.bounds
    m_lon = 111320.0 * cos(radians((miny + maxy) * 0.5))
    if melhorar:
        clips = [polygon for polygon, _spec in layers]
    else:
        clips = clip_polygons(layers, region)
    region_ready = prep(region)
    airport_ready = prep(unary_union([polygon for polygon, _spec in layers]))
    pad = 0.002

    def decide(verts):
        lons = [v[0] for v in verts]
        lats = [v[1] for v in verts]
        if (
            max(lons) < minx - pad
            or min(lons) > maxx + pad
            or max(lats) < miny - pad
            or min(lats) > maxy + pad
        ):
            return None
        tri = Polygon([(v[0], v[1]) for v in verts])
        if tri.is_empty or not region_ready.intersects(tri):
            return False
        if proteger_agua and not airport_ready.intersects(tri):
            if all(sample_dem(grid, west, south, v[0], v[1]) <= SEA_M for v in verts):
                return False
        return True

    log("procurando a borda da malha")
    decisions = []
    locked_points = set()
    locked_edges = set()
    for _line, batch in read_batches(src):
        if batch is None:
            continue
        for index in range(0, len(batch) - 2, 3):
            verificar_cancelamento()
            verts = batch[index : index + 3]
            choice = decide(verts)
            if choice is None:
                continue
            decisions.append(choice)
            if not choice:
                for n in range(3):
                    locked_points.add(vertex_key(verts[n]))
                    locked_edges.add(edge_key(verts[n], verts[(n + 1) % 3]))

    def z_for(vertex, verts):
        weights = barycentric(vertex, verts[0], verts[1], verts[2])
        tiny = 1e-7
        zero = [n for n in range(3) if abs(weights[n]) <= tiny]
        if len(zero) >= 2:
            corner = next(n for n in range(3) if n not in zero)
            if vertex_key(verts[corner]) in locked_points:
                return vertex[2]
        elif len(zero) == 1:
            a, b = [n for n in range(3) if n != zero[0]]
            if edge_key(verts[a], verts[b]) in locked_edges:
                return vertex[2]
        if vertex_key(vertex) in locked_points:
            return vertex[2]
        dem_z = sample_dem(grid, west, south, vertex[0], vertex[1])
        z_value = height_on_mesh(vertex[0], vertex[1], layers, m_lon, dem_z, proteger_agua, blend_m)
        return vertex[2] if z_value is None else z_value

    nucleos = os.cpu_count() or 2
    if _fila_log is not None:
        workers = max(2, nucleos // 2)
    else:
        workers = max(2, nucleos - 1)
    log("cortando os triangulos em %d nucleos" % workers)

    def cortar_um(verts):
        verificar_cancelamento()
        return [tuple((v[0], v[1], z_for(v, verts), *v[3:]) for v in piece) for piece in cut_triangle(verts, clips, region, melhorar)]

    kept = 0
    cut = 0
    turn = 0
    before = 0
    after = 0
    pending_begin = None
    patch_cut = []
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        def write_block(begin, pieces):
            for start in range(0, len(pieces), 2000):
                fout.write(begin)
                for piece in pieces[start : start + 2000]:
                    for vertex in piece:
                        fout.write(format_vertex(vertex, vertex[2]))
                fout.write("END_PRIMITIVE\n")

        with open(dst, "w", encoding="utf-8", newline="\n") as fout:
            for line, batch in read_batches(src):
                if batch is None:
                    if line.startswith("BEGIN_PRIMITIVE"):
                        pending_begin = line
                        continue
                    if line.startswith("END_PATCH") and patch_cut:
                        before += len(patch_cut)
                        merged = merge_flat(patch_cut)
                        after += len(merged)
                        write_block(patch_begin, merged)
                        patch_cut = []
                    fout.write(line)
                    continue
                begin = pending_begin or "BEGIN_PRIMITIVE 0\n"
                direct = []
                made = []
                futuros = []
                for index in range(0, len(batch) - 2, 3):
                    verificar_cancelamento()
                    verts = batch[index : index + 3]
                    lons = [v[0] for v in verts]
                    lats = [v[1] for v in verts]
                    near = not (
                        max(lons) < minx - pad
                        or min(lons) > maxx + pad
                        or max(lats) < miny - pad
                        or min(lats) > maxy + pad
                    )
                    do_cut = False
                    if near:
                        do_cut = decisions[turn]
                        turn += 1
                    if not do_cut:
                        direct.append(tuple(verts))
                        kept += 1
                        continue
                    futuros.append(pool.submit(cortar_um, tuple(verts)))
                    cut += 1
                    if cut % 2000 == 0:
                        log("cortando... %d" % cut)
                for futuro in futuros:
                    made.extend(futuro.result())
                if otimizar and begin.split()[1:2] == ["0"]:
                    patch_begin = begin
                    patch_cut.extend(made)
                    made = []
                if direct or made:
                    fout.write(begin)
                    for piece in direct + made:
                        for vertex in piece:
                            fout.write(format_vertex(vertex, vertex[2]))
                    fout.write(line)
    finally:
        pool.shutdown(wait=True)
    log("triangulos cortados %d, mantidos %d" % (cut, kept))
    if otimizar:
        log("otimizacao: %d pedacos viraram %d" % (before, after))
    return cut


def cortar_em_texto(path, work, layers, log, proteger_agua=True, blend_m=BLEND_M, otimizar=False, melhorar=False):
    """Extrai o DSF original em texto e grava o corte em work/cut.txt."""
    backup = path + ".antes_osm"
    source = backup if os.path.isfile(backup) else path
    inicio = time.time()
    raw, _compressed = load_dsf(source, work)
    log("7z aberto em %.0f s" % (time.time() - inicio))
    txt = os.path.join(work, "tile.txt")
    inicio = time.time()
    run_quiet([dsf_tool(), "--dsf2text", raw, txt])
    log("malha em texto em %.0f s" % (time.time() - inicio))
    elev = txt + ".elevation.raw"
    if not os.path.isfile(elev):
        raise RuntimeError("o tile nao tem grade de altitude: " + os.path.basename(path))
    count = os.path.getsize(elev) // 2
    side = int(round(count ** 0.5))
    grid = numpy.fromfile(elev, dtype="<i2", count=side * side).reshape(side, side)
    data = open(raw, "rb").read()
    props = read_props(data)
    lat, lon = tile_of(path)
    west = float(props.get("sim/west", lon))
    south = float(props.get("sim/south", lat))
    out_txt = os.path.join(work, "cut.txt")
    inicio = time.time()
    cut_mesh_text(txt, out_txt, layers, grid, west, south, log, proteger_agua, blend_m, otimizar, melhorar)
    log("corte em %.0f s" % (time.time() - inicio))
    return out_txt


def recortar_dsf(path, layers, log, proteger_agua=True, blend_m=BLEND_M, otimizar=False, melhorar=False):
    """Corta a malha do DSF original e grava por cima, sem trocar o backup."""
    work = tempfile.mkdtemp(prefix="malha_")
    try:
        out_txt = cortar_em_texto(path, work, layers, log, proteger_agua, blend_m, otimizar, melhorar)
        out_dsf = os.path.join(work, os.path.basename(path))
        inicio = time.time()
        run_quiet([dsf_tool(), "--text2dsf", out_txt, out_dsf])
        log("texto para dsf em %.0f s" % (time.time() - inicio))
        inicio = time.time()
        store_dsf(out_dsf, path, True)
        log("7z gravado em %.0f s" % (time.time() - inicio))
    finally:
        shutil.rmtree(work, ignore_errors=True)


PROJETO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OSM_DIR = os.path.join(PROJETO, "osm")
EDITOR_DIR = os.path.join(PROJETO, "editor")
CONFIG_PATH = os.path.join(PROJETO, "config.json")
PASTA_PADRAO = r"D:\SteamLibrary\steamapps\common\X-Plane 12\XPlane Map Enhancement Data"


def ler_config():
    base = {"pasta": PASTA_PADRAO, "faixa": 70, "otimizar": False, "melhorar": False}
    if not os.path.isfile(CONFIG_PATH):
        return base
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return base
    if not data.get("pasta"):
        data["pasta"] = PASTA_PADRAO
    if not data.get("faixa"):
        data["faixa"] = 70
    return data


def gravar_config(pasta, faixa, otimizar=False, melhorar=False):
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump(
            {"pasta": pasta, "faixa": faixa, "otimizar": bool(otimizar), "melhorar": bool(melhorar)},
            handle,
            ensure_ascii=False,
            indent=2,
        )


def ler_faixa(texto):
    try:
        valor = float(str(texto).replace(",", "."))
    except ValueError:
        raise RuntimeError("A faixa precisa ser um número em metros.")
    if valor < 0 or valor > 500:
        raise RuntimeError("A faixa fica entre 0 e 500 m.")
    return valor


def dsfs_do_osm(folder, osm):
    patch = load_patch(osm)
    return [path for path in xpme_dsfs(folder) if cobre_tile(patch, path)]


def xpme_dsfs(folder):
    dsfs = find_dsfs(folder)
    south = [path for path in dsfs if "XPME_South_America" in path]
    return south or dsfs


def osm_do_projeto():
    os.makedirs(OSM_DIR, exist_ok=True)
    return sorted(
        os.path.join(OSM_DIR, name) for name in os.listdir(OSM_DIR) if name.lower().endswith(".osm")
    )


def cobre_tile(patch, path):
    flats, ramps, _bounds = patch
    lat, lon = tile_of(path)
    tile = box(lon, lat, lon + 1, lat + 1)
    return any(poly.intersects(tile) for poly, _alt in flats) or any(
        poly.intersects(tile) for poly, *_rest in ramps
    )


def plano_por_tile(folder, origens, log):
    """Cada tile recebe todos os OSM do projeto que caem nele, porque o corte parte do backup e apagaria os outros."""
    dsfs = xpme_dsfs(folder)
    if not dsfs:
        raise RuntimeError("nenhum DSF nessa pasta")
    patches = {}
    for osm in dict.fromkeys(list(origens) + osm_do_projeto()):
        try:
            patches[osm] = load_patch(osm)
        except (ValueError, ET.ParseError) as exc:
            if osm in origens:
                raise
            log("ignorado %s: %s" % (os.path.basename(osm), exc))
    plano = []
    for path in dsfs:
        escolhidos = [osm for osm in origens if cobre_tile(patches[osm], path)]
        if not escolhidos:
            continue
        juntos = sorted(
            (osm for osm in patches if cobre_tile(patches[osm], path)),
            key=lambda osm: os.path.basename(osm).lower(),
        )
        extras = [osm for osm in juntos if osm not in origens]
        if extras:
            log("%s: incluindo tambem %s, que cai no mesmo tile" % (
                os.path.basename(path), ", ".join(os.path.basename(osm) for osm in extras)))
        plano.append((path, juntos))
    if not plano:
        raise RuntimeError("nenhum DSF cobre a area dos OSM marcados")
    return plano


_fila_log = None


def _iniciar_processo(evento, fila):
    global cancelar, _fila_log
    cancelar = evento
    _fila_log = fila


def compilar_tile(path, osms, opcoes, log=None):
    """Corta um tile com todos os OSM dele. Roda num processo separado ou no próprio processo."""
    nome = os.path.basename(path)

    def escrever(texto):
        linha = "%s  %s" % (nome, texto)
        if log is not None:
            log(linha)
        elif _fila_log is not None:
            _fila_log.put(linha)

    try:
        layers = []
        for osm in osms:
            flats, ramps, _bounds = load_patch(osm)
            layers += layers_of(flats, ramps)
        escrever("%d OSM, %d poligonos, faixa %.0f m" % (len(osms), len(layers), opcoes["faixa"]))
        backup = path + ".antes_osm"
        if not os.path.isfile(backup):
            shutil.copy2(path, backup)
            escrever("backup criado")
        inicio = time.time()
        recortar_dsf(path, layers, escrever, True, opcoes["faixa"], opcoes["otimizar"], opcoes["melhorar"])
        escrever("pronto em %.0f s" % (time.time() - inicio))
        return "ok"
    except Cancelado:
        return "cancelado"
    except Exception as exc:
        raise RuntimeError("%s: %s" % (nome, exc)) from None


def compilar_varios(folder, origens, log, opcoes, progresso=None, paralelo=True):
    """Compila os OSM marcados agrupados por tile. Tiles diferentes rodam ao mesmo tempo."""
    global _evento_processos
    plano = plano_por_tile(folder, origens, log)
    total = len(plano)
    if progresso:
        progresso(0, total)
    if not paralelo or total == 1:
        for feito, (path, osms) in enumerate(plano, start=1):
            if compilar_tile(path, osms, opcoes, log) == "cancelado" or cancelar.is_set():
                raise Cancelado()
            if progresso:
                progresso(feito, total)
        return total
    contexto = multiprocessing.get_context("spawn")
    evento = contexto.Event()
    fila = contexto.Queue()
    _evento_processos = evento
    if cancelar.is_set():
        evento.set()
    nucleos = os.cpu_count() or 2
    processos = max(1, min(total, nucleos - 1))
    log("%d tiles, %d ao mesmo tempo" % (total, processos))

    def esvaziar():
        while True:
            try:
                log(fila.get_nowait())
            except Exception:
                return

    feito = 0
    erro = None
    try:
        with ProcessPoolExecutor(
            max_workers=processos,
            mp_context=contexto,
            initializer=_iniciar_processo,
            initargs=(evento, fila),
        ) as pool:
            pendentes = {pool.submit(compilar_tile, path, osms, opcoes) for path, osms in plano}
            while pendentes:
                prontos, pendentes = wait(pendentes, timeout=0.3, return_when=FIRST_COMPLETED)
                esvaziar()
                if cancelar.is_set():
                    evento.set()
                for futuro in prontos:
                    try:
                        resultado = futuro.result()
                    except Exception as exc:
                        erro = erro or exc
                        evento.set()
                        continue
                    if resultado == "ok":
                        feito += 1
                        if progresso:
                            progresso(feito, total)
            esvaziar()
    finally:
        _evento_processos = None
    if erro is not None:
        raise erro
    if cancelar.is_set():
        raise Cancelado()
    return total


def aplicar(folder, osm, log, proteger_agua=True, blend_m=70.0, otimizar=False, melhorar=False):
    opcoes = {"faixa": blend_m, "otimizar": otimizar, "melhorar": melhorar}
    return compilar_varios(folder, [osm], log, opcoes, paralelo=False)


def recuperar_varios(folder, origens, log, progresso=None):
    """Restaura cada tile uma vez, mesmo quando vários OSM caem nele."""
    visto = []
    for osm in origens:
        for path in dsfs_do_osm(folder, osm):
            if path not in visto:
                visto.append(path)
    if not visto:
        raise RuntimeError("nenhum DSF cobre a area desses OSM")
    restored = 0
    total = len(visto)
    if progresso:
        progresso(0, total)
    for path in visto:
        verificar_cancelamento()
        backup = path + ".antes_osm"
        if not os.path.isfile(backup):
            log("sem backup: " + path)
            continue
        shutil.copy2(backup, path)
        log("recuperado " + os.path.basename(path))
        restored += 1
        if progresso:
            progresso(restored, total)
    if not restored:
        raise RuntimeError("os tiles desses OSM ainda nao tem backup")
    return restored


def recuperar(folder, osm, log, proteger_agua=True):
    return recuperar_varios(folder, [osm], log)


def porta_aberta(port):
    sock = socket.socket()
    try:
        sock.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def abrir_editor(osm_path):
    os.makedirs(OSM_DIR, exist_ok=True)
    cfg_path = os.path.join(EDITOR_DIR, "editor-config.json")
    with open(cfg_path, "w", encoding="utf-8") as handle:
        json.dump(
            {"patches_dir": OSM_DIR, "last_file": os.path.basename(osm_path)},
            handle,
            ensure_ascii=False,
            indent=2,
        )
    spec = importlib.util.spec_from_file_location("servir_editor", os.path.join(EDITOR_DIR, "servir-editor.py"))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    url = modulo.garantir_servidor()
    try:
        import webview
    except ImportError as exc:
        raise RuntimeError("Falta o pywebview. Rode: py -3.12 -m pip install pywebview") from exc
    webview.create_window("OsmTerreno — editor", url, width=1280, height=860)
    webview.start()


def triangulos_do_texto(txt, bbox):
    """Triângulos que tocam a caixa (oeste, sul, leste, norte), sem repetir as camadas."""
    west, south, east, north = bbox
    seen = set()
    tris = []
    for _line, batch in read_batches(txt):
        if batch is None:
            continue
        for index in range(0, len(batch) - 2, 3):
            verts = batch[index : index + 3]
            if not any(west <= v[0] <= east and south <= v[1] <= north for v in verts):
                continue
            key = tuple(sorted(vertex_key(v) for v in verts))
            if key in seen:
                continue
            seen.add(key)
            tris.append(tuple((v[0], v[1], v[2]) for v in verts))
    return tris


def malha_da_area(path, bbox):
    work = tempfile.mkdtemp(prefix="visor_")
    try:
        raw, _compressed = load_dsf(path, work)
        txt = os.path.join(work, "tile.txt")
        run_quiet([dsf_tool(), "--dsf2text", raw, txt])
        return triangulos_do_texto(txt, bbox)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def previa_da_area(path, layers, bbox, blend_m, otimizar, log, melhorar=False):
    """Corta o original em memória, sem gravar o DSF, e devolve os triângulos da área."""
    work = tempfile.mkdtemp(prefix="previa_")
    try:
        out_txt = cortar_em_texto(path, work, layers, log, True, blend_m, otimizar, melhorar)
        return triangulos_do_texto(out_txt, bbox)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def cor_altura(z, low, high):
    if z <= SEA_M:
        return "#1d4f8c"
    t = 0.0 if high <= low else min(max((z - low) / (high - low), 0.0), 1.0)
    stops = ((0.0, (60, 140, 70)), (0.5, (200, 190, 90)), (1.0, (190, 90, 50)))
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            rgb = [int(c0[i] + (c1[i] - c0[i]) * k) for i in range(3)]
            return "#%02x%02x%02x" % tuple(rgb)
    return "#be5a32"


class VisorMalha(tk.Toplevel):
    def __init__(self, master, folder, osm, blend_m=BLEND_M, melhorar=False):
        super().__init__(master)
        self.blend_m = blend_m
        self.melhorar = melhorar
        self.title("Malha — " + os.path.basename(osm))
        self.geometry("1000x760")
        self.folder = folder
        self.osm = osm
        self.fonte = tk.StringVar(value="atual")
        self.info = tk.StringVar(value="Lendo o DSF…")
        self.itens = {}
        topo = ttk.Frame(self)
        topo.pack(fill="x", padx=8, pady=6)
        ttk.Radiobutton(topo, text="Compilado", variable=self.fonte, value="atual", command=self.carregar).pack(side="left")
        ttk.Radiobutton(topo, text="Original (.antes_osm)", variable=self.fonte, value="original", command=self.carregar).pack(side="left", padx=(8, 0))
        ttk.Radiobutton(topo, text="Prévia normal", variable=self.fonte, value="previa", command=self.carregar).pack(side="left", padx=(8, 0))
        ttk.Radiobutton(topo, text="Prévia otimizada", variable=self.fonte, value="otimizada", command=self.carregar).pack(side="left", padx=(8, 0))
        ttk.Label(topo, textvariable=self.info).pack(side="left", padx=12)
        self.canvas = tk.Canvas(self, background="#111111", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        rodape = ttk.Frame(self)
        rodape.pack(fill="x", padx=8, pady=4)
        self.posicao = tk.StringVar(value="")
        ttk.Label(rodape, textvariable=self.posicao, font=("Consolas", 10)).pack(side="left")
        ttk.Label(
            rodape,
            text="Roda: zoom   Arrastar: mover   Botão direito: copiar coordenada",
        ).pack(side="right")
        self.transf = None
        self.canvas.bind("<MouseWheel>", self.zoom)
        self.canvas.bind("<ButtonPress-3>", self.copiar_coordenada)
        self.canvas.bind("<ButtonPress-1>", lambda e: self.canvas.scan_mark(e.x, e.y))
        self.canvas.bind("<B1-Motion>", lambda e: self.canvas.scan_dragto(e.x, e.y, gain=1))
        self.canvas.bind("<Motion>", self.mostrar_altura)
        self.flats, self.ramps, bounds = load_patch(osm)
        pad = 250.0 / 111320.0
        self.bbox = (bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad)
        self.carregar()

    def carregar(self):
        paths = dsfs_do_osm(self.folder, self.osm)
        if not paths:
            self.info.set("Nenhum DSF cobre esse OSM.")
            return
        fonte = self.fonte.get()
        self.pedido = getattr(self, "pedido", 0) + 1
        pedido = self.pedido
        escolhidos = []
        for path in paths:
            backup = path + ".antes_osm"
            if fonte == "original":
                if os.path.isfile(backup):
                    escolhidos.append(backup)
            else:
                escolhidos.append(path)
        if not escolhidos:
            self.info.set("Esse tile ainda não tem backup .antes_osm.")
            return
        self.canvas.delete("all")
        previa = fonte in ("previa", "otimizada")
        self.info.set("Cortando em memória, leva alguns minutos…" if previa else "Lendo o DSF…")
        bbox = self.bbox
        layers = layers_of(self.flats, self.ramps)
        blend_m = self.blend_m
        melhorar = self.melhorar

        def aviso(texto):
            self.after(0, lambda: pedido == self.pedido and self.info.set("Prévia: " + texto))

        def trabalho():
            try:
                tris = []
                for path in escolhidos:
                    if previa:
                        tris.extend(previa_da_area(path, layers, bbox, blend_m, fonte == "otimizada", aviso, melhorar))
                    else:
                        tris.extend(malha_da_area(path, bbox))
            except Exception as exc:
                self.after(0, lambda exc=exc: pedido == self.pedido and self.info.set("Erro: " + str(exc)))
                return
            self.after(0, lambda: pedido == self.pedido and self.desenhar(tris))

        threading.Thread(target=trabalho, daemon=True).start()

    def desenhar(self, tris):
        if not self.winfo_exists():
            return
        self.canvas.delete("all")
        self.itens = {}
        west, south, east, north = self.bbox
        m_lon = 111320.0 * cos(radians((south + north) * 0.5))
        largura = max(self.canvas.winfo_width(), 400)
        altura = max(self.canvas.winfo_height(), 300)
        escala = min(largura / ((east - west) * m_lon), altura / ((north - south) * 111320.0))

        def xy(lon, lat):
            return ((lon - west) * m_lon * escala, (north - lat) * 111320.0 * escala)

        self.transf = {"west": west, "north": north, "sx": m_lon * escala, "sy": 111320.0 * escala, "k": 1.0, "ox": 0.0, "oy": 0.0}

        zs = [v[2] for tri in tris for v in tri if v[2] > SEA_M]
        low = min(zs) if zs else 0.0
        high = max(zs) if zs else 1.0
        for tri in tris:
            z = sum(v[2] for v in tri) / 3.0
            coords = [c for v in tri for c in xy(v[0], v[1])]
            item = self.canvas.create_polygon(coords, fill=cor_altura(z, low, high), outline="#000000", width=1)
            self.itens[item] = tri
        for polygon, _alt in self.flats:
            coords = [c for lon, lat in polygon.exterior.coords for c in xy(lon, lat)]
            self.canvas.create_line(coords, fill="#ff3b3b", width=2)
        for polygon, *_rest in self.ramps:
            coords = [c for lon, lat in polygon.exterior.coords for c in xy(lon, lat)]
            self.canvas.create_line(coords, fill="#ff9f1a", width=2)
        nome = {
            "atual": "compilado",
            "original": "original",
            "previa": "prévia normal",
            "otimizada": "prévia otimizada",
        }[self.fonte.get()]
        self.info.set("%s: %d triângulos na área   altura %.1f a %.1f m" % (nome, len(tris), low, high))

    def zoom(self, event):
        fator = 1.25 if event.delta > 0 else 0.8
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        pendente = getattr(self, "_zoom", None)
        if pendente:
            self.after_cancel(pendente[0])
            fator *= pendente[1]
        self._zoom = (self.after(120, lambda: self._aplicar_zoom(x, y)), fator)

    def _aplicar_zoom(self, x, y):
        fator = self._zoom[1]
        self._zoom = None
        self.canvas.scale("all", x, y, fator, fator)
        if self.transf:
            t = self.transf
            t["k"] *= fator
            t["ox"] = x + (t["ox"] - x) * fator
            t["oy"] = y + (t["oy"] - y) * fator

    def coordenada(self, event):
        if not self.transf:
            return None
        t = self.transf
        cx = self.canvas.canvasx(event.x)
        cy = self.canvas.canvasy(event.y)
        bx = (cx - t["ox"]) / t["k"]
        by = (cy - t["oy"]) / t["k"]
        return (t["north"] - by / t["sy"], t["west"] + bx / t["sx"])

    def mostrar_altura(self, event):
        ponto = self.coordenada(event)
        if ponto is None:
            return
        texto = "lat %.7f   lon %.7f" % ponto
        atual = self.canvas.find_withtag("current")
        if atual and atual[0] in self.itens:
            tri = self.itens[atual[0]]
            texto += "   vértices: %s m" % ", ".join("%.2f" % v[2] for v in tri)
        self.posicao.set(texto)

    def copiar_coordenada(self, event):
        ponto = self.coordenada(event)
        if ponto is None:
            return
        texto = "%.7f, %.7f" % ponto
        self.clipboard_clear()
        self.clipboard_append(texto)
        self.posicao.set("copiado: " + texto)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("OsmTerreno")
        self.geometry("860x580")
        self.minsize(720, 480)
        cfg = ler_config()
        self.folder = tk.StringVar(value=cfg["pasta"])
        self.faixa = tk.StringVar(value=str(cfg.get("faixa", 70)))
        self.otimizar = tk.BooleanVar(value=bool(cfg.get("otimizar", False)))
        self.melhorar = tk.BooleanVar(value=bool(cfg.get("melhorar", False)))
        self.status = tk.StringVar(value="Pronto")
        self.busy = False
        self.fechando = False
        self.botoes = []
        self.protocol("WM_DELETE_WINDOW", self.ao_fechar)
        pad = {"padx": 10, "pady": 4}
        frm = ttk.Frame(self)
        frm.pack(fill="x", **pad)
        ttk.Label(frm, text="Pasta dos terrenos").grid(row=0, column=0, sticky="w")
        self.entrada_pasta = ttk.Entry(frm, textvariable=self.folder, width=78)
        self.entrada_pasta.grid(row=1, column=0, sticky="we")
        self._botao(frm, "Pasta...", self.pick_folder).grid(row=1, column=1, padx=6)
        frm.columnconfigure(0, weight=1)

        body = ttk.Frame(self)
        body.pack(fill="both", expand=True, **pad)
        left = ttk.Frame(body)
        left.pack(side="left", fill="both", expand=True)
        ttk.Label(left, text="OSM").pack(anchor="w")
        self.marcas = {}
        caixa = ttk.Frame(left)
        caixa.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(caixa, highlightthickness=0)
        barra = ttk.Scrollbar(caixa, orient="vertical", command=self.canvas.yview)
        self.lista_frame = ttk.Frame(self.canvas)
        self.lista_frame.bind(
            "<Configure>",
            lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")),
        )
        self.canvas.create_window((0, 0), window=self.lista_frame, anchor="nw")
        self.canvas.configure(yscrollcommand=barra.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        barra.pack(side="right", fill="y")
        botoes = ttk.Frame(left)
        botoes.pack(fill="x", pady=6)
        for texto, comando in (
            ("Importar", self.importar),
            ("Exportar", self.exportar),
            ("Apagar", self.apagar),
            ("Editar", self.editar),
            ("Ver malha", self.ver_malha),
            ("Selecionar tudo", self.marcar_todos),
            ("Desmarcar tudo", self.desmarcar_todos),
        ):
            self._botao(botoes, texto, comando).pack(side="left", padx=(0, 4))

        acoes = ttk.LabelFrame(body, text="Ações")
        acoes.pack(side="left", fill="y", padx=(10, 0))
        ttk.Label(acoes, text="Faixa ao redor (m)").pack(anchor="w", padx=8, pady=(8, 0))
        self.entrada_faixa = ttk.Entry(acoes, textvariable=self.faixa, width=8)
        self.entrada_faixa.pack(anchor="w", padx=8, pady=(2, 6))
        self.caixa_otimizar = ttk.Checkbutton(acoes, text="Otimizar malha (teste)", variable=self.otimizar)
        self.caixa_otimizar.pack(anchor="w", padx=8, pady=(0, 6))
        self.caixa_melhorar = ttk.Checkbutton(acoes, text="Melhorar triângulos", variable=self.melhorar)
        self.caixa_melhorar.pack(anchor="w", padx=8, pady=(0, 6))
        self._botao(acoes, "Compilar", self.compilar).pack(fill="x", padx=8, pady=(8, 4))
        self._botao(acoes, "Recuperar", self.recuperar_click).pack(fill="x", padx=8, pady=4)

        self.log = tk.Text(self, height=12, wrap="word")
        self.log.pack(fill="both", expand=True, padx=10, pady=(0, 4))
        rodape = ttk.Frame(self)
        rodape.pack(fill="x", padx=10, pady=(0, 10))
        ttk.Label(rodape, textvariable=self.status).pack(anchor="w")
        self.progresso = ttk.Progressbar(rodape, mode="determinate", maximum=1)
        self.progresso.pack(fill="x", pady=(4, 0))
        self.recarregar()

    def _botao(self, pai, texto, comando):
        botao = ttk.Button(pai, text=texto, command=comando)
        self.botoes.append(botao)
        return botao

    def ao_fechar(self):
        if self.busy:
            if not messagebox.askyesno(
                "OsmTerreno",
                "A compilação está em andamento.\nCancelar tudo e fechar?",
            ):
                return
            self.fechando = True
            pedir_cancelamento()
            self.destroy()
            return
        if messagebox.askokcancel("OsmTerreno", "Fechar o OsmTerreno?"):
            self.fechando = True
            self.destroy()

    def _travar(self, travado):
        estado = "disabled" if travado else "normal"
        for botao in self.botoes:
            botao.configure(state=estado)
        self.entrada_pasta.configure(state=estado)
        self.entrada_faixa.configure(state=estado)
        self.caixa_otimizar.configure(state=estado)
        self.caixa_melhorar.configure(state=estado)
        for filho in self.lista_frame.winfo_children():
            try:
                filho.configure(state=estado)
            except tk.TclError:
                pass

    def pick_folder(self):
        path = filedialog.askdirectory(initialdir=self.folder.get() or "D:\\")
        if path:
            self.folder.set(path)
            try:
                faixa = ler_faixa(self.faixa.get())
            except RuntimeError:
                faixa = 70
            gravar_config(path, faixa, self.otimizar.get(), self.melhorar.get())

    def selecionados(self):
        escolhidos = [nome for nome, var in self.marcas.items() if var.get()]
        if not escolhidos:
            messagebox.showinfo("OsmTerreno", "Marque um ou mais OSM na lista.")
            return []
        return [os.path.join(OSM_DIR, nome) for nome in escolhidos]

    def marcar_todos(self):
        for var in self.marcas.values():
            var.set(True)

    def desmarcar_todos(self):
        for var in self.marcas.values():
            var.set(False)

    def recarregar(self, nome=None):
        for filho in self.lista_frame.winfo_children():
            filho.destroy()
        self.marcas = {}
        os.makedirs(OSM_DIR, exist_ok=True)
        nomes = sorted(n for n in os.listdir(OSM_DIR) if n.lower().endswith(".osm"))
        for nome_arquivo in nomes:
            var = tk.BooleanVar(value=nome_arquivo == nome)
            self.marcas[nome_arquivo] = var
            ttk.Checkbutton(self.lista_frame, text=nome_arquivo, variable=var).pack(anchor="w", fill="x")

    def importar(self):
        path = filedialog.askopenfilename(
            initialdir=OSM_DIR,
            filetypes=[("OSM", "*.osm"), ("Todos", "*.*")],
        )
        if not path:
            return
        destino = os.path.join(OSM_DIR, os.path.basename(path))
        if os.path.abspath(path) != os.path.abspath(destino):
            shutil.copy2(path, destino)
        self.recarregar(os.path.basename(destino))
        self.write("importado " + os.path.basename(destino))

    def exportar(self):
        origens = self.selecionados()
        if not origens:
            return
        if len(origens) == 1:
            origem = origens[0]
            destino = filedialog.asksaveasfilename(
                initialfile=os.path.basename(origem),
                defaultextension=".osm",
                filetypes=[("OSM", "*.osm")],
            )
            if not destino:
                return
            shutil.copy2(origem, destino)
            self.write("exportado " + destino)
            return
        pasta = filedialog.askdirectory()
        if not pasta:
            return
        for origem in origens:
            destino = os.path.join(pasta, os.path.basename(origem))
            shutil.copy2(origem, destino)
            self.write("exportado " + destino)

    def apagar(self):
        origens = self.selecionados()
        if not origens:
            return
        nomes = ", ".join(os.path.basename(p) for p in origens)
        if not messagebox.askyesno("OsmTerreno", "Apagar da lista: " + nomes + "?"):
            return
        for origem in origens:
            os.remove(origem)
            self.write("apagado " + os.path.basename(origem))
        self.recarregar()

    def editar(self):
        origens = self.selecionados()
        if not origens:
            return
        if len(origens) > 1:
            messagebox.showinfo("OsmTerreno", "Editar abre um OSM. Deixe só um selecionado.")
            return
        try:
            abrir_editor(origens[0])
        except Exception as exc:
            messagebox.showerror("OsmTerreno", str(exc))
            return
        self.write("editor aberto em " + os.path.basename(origens[0]))

    def ver_malha(self):
        origens = self.selecionados()
        if not origens:
            return
        if len(origens) > 1:
            messagebox.showinfo("OsmTerreno", "Ver malha abre um OSM. Deixe só um selecionado.")
            return
        folder = self.folder.get().strip()
        if not os.path.isdir(folder):
            messagebox.showerror("OsmTerreno", "A pasta dos terrenos nao existe.")
            return
        try:
            blend_m = ler_faixa(self.faixa.get())
        except RuntimeError:
            blend_m = BLEND_M
        try:
            VisorMalha(self, folder, origens[0], blend_m, self.melhorar.get())
        except Exception as exc:
            messagebox.showerror("OsmTerreno", str(exc))

    def write(self, line):
        self.after(0, lambda line=line: self._escrever(line))

    def _escrever(self, line):
        self.log.insert("end", line + "\n")
        self.log.see("end")

    def _rodar(self, func):
        if self.busy:
            return
        origens = self.selecionados()
        folder = self.folder.get().strip()
        if not origens:
            return
        if not os.path.isdir(folder):
            messagebox.showerror("OsmTerreno", "A pasta dos terrenos nao existe.")
            return
        try:
            faixa = ler_faixa(self.faixa.get())
        except RuntimeError as exc:
            messagebox.showerror("OsmTerreno", str(exc))
            return
        otimizar = self.otimizar.get()
        melhorar = self.melhorar.get()
        gravar_config(folder, faixa, otimizar, melhorar)
        cancelar.clear()
        self.fechando = False
        self.busy = True
        self._travar(True)
        self.log.delete("1.0", "end")
        total = len(origens)
        self._mostrar_progresso(0, total, "Preparando…")

        def andamento(feito, quantos):
            texto = "Tiles prontos: %d de %d" % (feito, quantos)
            self.after(0, lambda: self._mostrar_progresso(feito, quantos, texto))

        def trabalho():
            nonlocal total
            try:
                if func is aplicar:
                    opcoes = {"faixa": faixa, "otimizar": otimizar, "melhorar": melhorar}
                    total = compilar_varios(folder, origens, self.write, opcoes, andamento)
                else:
                    total = recuperar_varios(folder, origens, self.write, andamento)
            except Cancelado:
                pass
            except Exception as exc:
                if not self.fechando:
                    self.after(0, lambda exc=exc: self.write("erro: " + str(exc)))
                    self.after(0, lambda exc=exc: self.status.set("Falhou: " + str(exc)))
                    self.after(0, lambda exc=exc: messagebox.showerror("OsmTerreno", str(exc)))
            else:
                if not self.fechando and not cancelar.is_set():
                    self.after(0, lambda: self._mostrar_progresso(total, total, "Concluído"))
                    self.after(0, lambda: messagebox.showinfo(
                        "OsmTerreno",
                        "Compilação concluída.\nReinicie o X-Plane para ver.",
                    ))
            finally:
                if not self.fechando:
                    self.after(0, self._liberar)

        threading.Thread(target=trabalho, daemon=True).start()

    def _mostrar_progresso(self, feito, total, texto):
        self.status.set(texto)
        self.title("OsmTerreno — " + texto)
        self.progresso.stop()
        self.progresso.configure(mode="determinate", maximum=max(total, 1), value=feito)

    def _liberar(self):
        self.busy = False
        self._travar(False)
        if self.status.get() == "Concluído":
            self.title("OsmTerreno — concluído")

    def compilar(self):
        self._rodar(aplicar)

    def recuperar_click(self):
        origens = self.selecionados()
        if not origens:
            return
        nomes = ", ".join(os.path.basename(p) for p in origens)
        if not messagebox.askyesno(
            "OsmTerreno",
            "Voltar o DSF destes OSM para o backup original?\n" + nomes,
        ):
            return
        self._rodar(recuperar)


def compilar_todos():
    """Usado pelo Compilar.bat: todos os OSM da pasta osm, com as opções salvas na janela."""
    config = ler_config()
    opcoes = {
        "faixa": ler_faixa(str(config.get("faixa", BLEND_M))),
        "otimizar": bool(config.get("otimizar")),
        "melhorar": bool(config.get("melhorar")),
    }
    origens = osm_do_projeto()
    if not origens:
        print("nenhum OSM na pasta osm")
        return 1
    try:
        compilar_varios(config["pasta"], origens, print, opcoes,
                        lambda feito, total: print("tiles prontos: %d de %d" % (feito, total)))
    except KeyboardInterrupt:
        pedir_cancelamento()
        print("cancelado")
        return 1
    except Exception as exc:
        print("erro: %s" % exc)
        return 1
    return 0


if __name__ == "__main__":
    import sys

    if "--compilar-todos" in sys.argv:
        sys.exit(compilar_todos())
    App().mainloop()
