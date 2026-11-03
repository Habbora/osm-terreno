"""Edita o terreno do Map Enhancement com as altitudes de um .patch.osm.

A grade original tem cerca de 90 m e nao acompanha o contorno do aeroporto.
O programa refina essa grade e pinta cada celula que o poligono do OSM toca.
"""
import hashlib
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import tkinter as tk
import webbrowser
import xml.etree.ElementTree as ET
from math import cos, hypot, radians, tanh
from tkinter import filedialog, messagebox, ttk

import numpy
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, box
from shapely.ops import triangulate, unary_union
from shapely.prepared import prep

M_LAT = 110540.0


def seven_zip():
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "7z.exe"),
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
        r"C:\Users\aliss\Downloads\Ortho4XP-master\Ortho4XP-master\Utils\win\7z.exe",
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    raise FileNotFoundError("7z.exe nao encontrado")


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


def elevation_span(data):
    off = 12
    end = len(data) - 16
    while off + 8 <= end:
        aid = data[off : off + 4][::-1].decode("ascii", "replace")
        length = struct.unpack_from("<I", data, off + 4)[0]
        if aid == "DEMS":
            sub = off + 8
            stop = off + length
            pending = None
            while sub + 8 <= stop:
                sid = data[sub : sub + 4][::-1].decode("ascii", "replace")
                slen = struct.unpack_from("<I", data, sub + 4)[0]
                if sid == "DEMI":
                    info = data[sub + 8 : sub + slen]
                    width, height = struct.unpack_from("<II", info, 4)
                    scale, offset = struct.unpack_from("<ff", info, 12)
                    pending = (width, height, scale, offset)
                elif sid == "DEMD" and pending and slen - 8 == pending[0] * pending[1] * 2:
                    width, height, scale, offset = pending
                    return sub + 8, width, height, scale, offset
                sub += slen
        if length < 8:
            break
        off += length
    return None


FINE = 4801


def upsample(grid, fine):
    """Stretch the degree raster so a cell is about 23 m, close to the mesh."""
    height, width = grid.shape
    rows = numpy.linspace(0, height - 1, fine)
    cols = numpy.linspace(0, width - 1, fine)
    r0 = numpy.floor(rows).astype(numpy.int32)
    c0 = numpy.floor(cols).astype(numpy.int32)
    r1 = numpy.minimum(r0 + 1, height - 1)
    c1 = numpy.minimum(c0 + 1, width - 1)
    fr = (rows - r0)[:, None]
    fc = (cols - c0)[None, :]
    src = grid.astype(numpy.float32)
    mixed = (
        src[r0][:, c0] * (1 - fr) * (1 - fc)
        + src[r0][:, c1] * (1 - fr) * fc
        + src[r1][:, c0] * fr * (1 - fc)
        + src[r1][:, c1] * fr * fc
    )
    return numpy.rint(mixed).astype(numpy.int16)


def paint(grid, west, south, width, height, scale, offset, flats, ramps):
    """Fill every cell the OSM polygon touches, so the airport keeps that outline."""
    m_lon = 111320.0 * cos(radians(south + 0.5))
    dlat = 1.0 / (height - 1)
    dlon = 1.0 / (width - 1)
    touched = numpy.zeros(grid.shape, dtype=bool)
    layers = [(poly, ("flat", alt)) for poly, alt in flats]
    layers += [(poly, ("ramp", h0, h1, l0, l1, high, low, profile)) for poly, h0, h1, l0, l1, high, low, profile in ramps]
    for polygon, spec in layers:
        minx, miny, maxx, maxy = polygon.bounds
        c0 = max(0, int((minx - west) / dlon) - 1)
        c1 = min(width - 1, int((maxx - west) / dlon) + 1)
        r0 = max(0, int((miny - south) / dlat) - 1)
        r1 = min(height - 1, int((maxy - south) / dlat) + 1)
        for row in range(r0, r1 + 1):
            lat0 = south + row * dlat
            for col in range(c0, c1 + 1):
                lon0 = west + col * dlon
                cell = box(lon0, lat0, lon0 + dlon, lat0 + dlat)
                if not polygon.intersects(cell):
                    continue
                lon = lon0 + dlon * 0.5
                lat = lat0 + dlat * 0.5
                if spec[0] == "flat":
                    height_m = spec[1]
                else:
                    _, h0, h1, l0, l1, high, low, profile = spec
                    d_high = segment_distance((lon, lat), h0, h1, m_lon)
                    d_low = segment_distance((lon, lat), l0, l1, m_lon)
                    span = d_high + d_low
                    t = 0.0 if span == 0 else d_high / span
                    height_m = high - profile(t) * (high - low)
                raw = int(round((height_m - offset) / scale))
                grid[row, col] = max(-32768, min(32767, raw))
                touched[row, col] = True
    return int(touched.sum())


def replace_elevation(data, grid, scale, offset):
    """Swap the first elevation raster. The new grid can be a different size."""
    height, width = grid.shape
    off = 12
    end = len(data) - 16
    while off + 8 <= end:
        length = struct.unpack_from("<I", data, off + 4)[0]
        aid = data[off : off + 4][::-1].decode("ascii", "replace")
        if aid == "DEMS":
            sub = off + 8
            stop = off + length
            demi_at = None
            info = None
            while sub + 8 <= stop:
                sid = data[sub : sub + 4][::-1].decode("ascii", "replace")
                slen = struct.unpack_from("<I", data, sub + 4)[0]
                if sid == "DEMI":
                    demi_at = sub
                    info = bytes(data[sub + 8 : sub + slen])
                elif sid == "DEMD" and demi_at is not None and info is not None:
                    head = info[:4] + struct.pack("<IIff", width, height, float(scale), float(offset))
                    demi = b"IMED" + struct.pack("<I", 8 + len(head)) + head
                    payload = numpy.ascontiguousarray(grid, dtype="<i2").tobytes()
                    demd = b"DMED" + struct.pack("<I", 8 + len(payload)) + payload
                    blob = demi + demd
                    local = demi_at - off
                    dems = bytearray(data[off : off + length])
                    dems[local : sub + slen - off] = blob
                    struct.pack_into("<I", dems, 4, len(dems))
                    out = bytearray(data[:off] + dems + data[off + length : -16])
                    out += b"\x00" * 16
                    out[-16:] = hashlib.md5(out[:-16]).digest()
                    return out
                sub += slen
        if length < 8:
            break
        off += length
    raise RuntimeError("grade de altitude nao encontrada")


def load_dsf(path, work):
    with open(path, "rb") as handle:
        magic = handle.read(2)
    raw = os.path.join(work, os.path.basename(path) + ".raw")
    if os.path.isfile(raw):
        os.remove(raw)
    if magic == b"7z":
        subprocess.check_call(
            [seven_zip(), "e", "-y", "-o" + work, path],
            stdout=subprocess.DEVNULL,
        )
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
    subprocess.check_call(
        [seven_zip(), "a", "-t7z", "-m0=LZMA", "-mx=5", "-md=48m", archive, "--", os.path.basename(src_raw)],
        cwd=folder,
        stdout=subprocess.DEVNULL,
    )
    os.replace(archive, dest)


def edit_file(path, flats, ramps, log):
    lat, lon = tile_of(path)
    tile = box(lon, lat, lon + 1, lat + 1)
    hit = any(poly.intersects(tile) for poly, _ in flats) or any(
        poly.intersects(tile) for poly, *_ in ramps
    )
    if not hit:
        return 0
    backup = path + ".antes_osm"
    work = tempfile.mkdtemp(prefix="xpme_")
    try:
        if not os.path.isfile(backup):
            shutil.copy2(path, backup)
            log("backup " + backup)
        raw, compressed = load_dsf(backup, work)
        if compressed:
            raw = os.path.join(work, os.path.basename(path))
        data = bytearray(open(raw, "rb").read())
        span = elevation_span(data)
        if span is None:
            log("sem grade de altitude, ignorado: " + os.path.basename(os.path.dirname(os.path.dirname(path))))
            return 0
        at, width, height, scale, offset = span
        props = read_props(data)
        west = float(props.get("sim/west", lon))
        south = float(props.get("sim/south", lat))
        coarse = numpy.frombuffer(data, dtype="<i2", count=width * height, offset=at).reshape(height, width).copy()
        grid = upsample(coarse, FINE)
        painted = paint(grid, west, south, FINE, FINE, scale, offset, flats, ramps)
        data = replace_elevation(data, grid, scale, offset)
        open(raw, "wb").write(data)
        store_dsf(raw, path, compressed)
        log("%s  grade %d  pixels do aeroporto %d" % (os.path.basename(path), FINE, painted))
        return painted
    finally:
        shutil.rmtree(work, ignore_errors=True)


def aplicar(folder, osm, log):
    flats, ramps, bounds = load_patch(osm)
    log("poligonos planos %d, rampas %d" % (len(flats), len(ramps)))
    dsfs = find_dsfs(folder)
    south = [path for path in dsfs if "XPME_South_America" in path]
    if south:
        dsfs = south
    if not dsfs:
        raise RuntimeError("nenhum DSF nessa pasta")
    total = 0
    used = 0
    for path in dsfs:
        painted = edit_file(path, flats, ramps, log)
        if painted:
            used += 1
            total += painted
    if not used:
        raise RuntimeError("nenhum DSF cobre a area do OSM")
    layers = [(poly, ("flat", alt)) for poly, alt in flats]
    layers += [
        (poly, ("ramp", h0, h1, l0, l1, high, low, profile))
        for poly, h0, h1, l0, l1, high, low, profile in ramps
    ]
    for path in dsfs:
        lat, lon = tile_of(path)
        tile = box(lon, lat, lon + 1, lat + 1)
        if any(poly.intersects(tile) for poly, _spec in layers):
            recortar_dsf(path, layers, log)
    log("pronto: %d pixels em %d arquivo(s)" % (total, used))
    return total


def dsf_tool():
    path = r"C:\Users\aliss\Downloads\Ortho4XP-master\Ortho4XP-master\Utils\win\DSFTool.exe"
    if not os.path.isfile(path):
        raise FileNotFoundError("DSFTool.exe nao encontrado")
    return path


BLEND_M = 70.0


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


def height_on_mesh(lon, lat, layers, m_lon, dem_z):
    """Dentro do polígono usa o OSM. Na faixa de 70 m desce liso até o terreno."""
    inside = altitude_at(lon, lat, layers, m_lon)
    if inside is not None:
        return inside
    point = Point(lon, lat)
    nearest = None
    nearest_m = None
    for polygon, spec in layers:
        dist_m = polygon.distance(point) * 111320.0
        if nearest_m is None or dist_m < nearest_m:
            nearest_m = dist_m
            nearest = (polygon, spec)
    if nearest is None or nearest_m is None or nearest_m >= BLEND_M:
        return dem_z
    border = nearest[0].exterior.interpolate(nearest[0].exterior.project(point))
    edge_z = spec_height(border.x, border.y, nearest[1], m_lon)
    t = nearest_m / BLEND_M
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


def clip_polygons(layers, m_lon):
    pad = BLEND_M / 111320.0
    clips = []
    for polygon, _spec in layers:
        clips.append(polygon)
        skirt = polygon.buffer(pad)
        if not skirt.is_empty:
            clips.append(skirt)
    return clips


def cut_triangle(verts, clips, region):
    """Divide um triângulo nas bordas do OSM. Cada vértice é (lon, lat, extras)."""
    corners = [(v[0], v[1]) for v in verts]
    if corners[0] == corners[1] or corners[1] == corners[2] or corners[0] == corners[2]:
        return [verts]
    tri = Polygon(corners)
    if tri.is_empty or not tri.is_valid:
        tri = tri.buffer(0)
    if tri.is_empty or not region.intersects(tri):
        return [verts]
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
    origin = signed_area(corners[0], corners[1], corners[2])
    made = []
    for piece in pieces:
        for small in triangulate(piece):
            if small.area <= 1e-14 or not piece.buffer(1e-12).covers(small.centroid):
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


def cut_mesh_text(src, dst, layers, grid, west, south, log):
    region = unary_union([polygon for polygon, _spec in layers]).buffer(BLEND_M / 111320.0)
    minx, miny, maxx, maxy = region.bounds
    m_lon = 111320.0 * cos(radians((miny + maxy) * 0.5))
    clips = clip_polygons(layers, m_lon)
    pad = 0.002
    kept = 0
    cut = 0
    with open(src, "r", encoding="utf-8", errors="ignore") as fin, open(dst, "w", encoding="utf-8", newline="\n") as fout:
        primitive = False
        batch = []
        for line in fin:
            if line.startswith("BEGIN_PRIMITIVE"):
                primitive = True
                batch = []
                fout.write(line)
                continue
            if line.startswith("END_PRIMITIVE"):
                primitive = False
                index = 0
                while index + 2 < len(batch):
                    verts = batch[index : index + 3]
                    lons = [v[0] for v in verts]
                    lats = [v[1] for v in verts]
                    near = (
                        max(lons) >= minx - pad
                        and min(lons) <= maxx + pad
                        and max(lats) >= miny - pad
                        and min(lats) <= maxy + pad
                    )
                    pieces = cut_triangle(verts, clips, region) if near else [verts]
                    if pieces == [verts]:
                        for vertex in verts:
                            fout.write(format_vertex(vertex, vertex[2]))
                        kept += 1
                    else:
                        for piece in pieces:
                            for vertex in piece:
                                dem_z = sample_dem(grid, west, south, vertex[0], vertex[1])
                                z_value = height_on_mesh(vertex[0], vertex[1], layers, m_lon, dem_z)
                                fout.write(format_vertex(vertex, z_value))
                        cut += 1
                    index += 3
                fout.write(line)
                continue
            if primitive and line.startswith("PATCH_VERTEX"):
                nums = tuple(float(item) for item in line.split()[1:])
                batch.append(nums)
                continue
            fout.write(line)
    log("triangulos cortados %d, mantidos %d" % (cut, kept))
    return cut


def recortar_dsf(path, layers, log):
    """Corta a malha do DSF original e grava por cima, sem trocar o backup."""
    backup = path + ".antes_osm"
    source = backup if os.path.isfile(backup) else path
    work = tempfile.mkdtemp(prefix="malha_")
    try:
        raw, _compressed = load_dsf(source, work)
        txt = os.path.join(work, "tile.txt")
        subprocess.check_call([dsf_tool(), "--dsf2text", raw, txt], stdout=subprocess.DEVNULL)
        elev = txt + ".elevation.raw"
        count = os.path.getsize(elev) // 2
        side = int(round(count ** 0.5))
        grid = numpy.fromfile(elev, dtype="<i2", count=side * side).reshape(side, side)
        data = open(raw, "rb").read()
        props = read_props(data)
        lat, lon = tile_of(path)
        west = float(props.get("sim/west", lon))
        south = float(props.get("sim/south", lat))
        out_txt = os.path.join(work, "cut.txt")
        cut_mesh_text(txt, out_txt, layers, grid, west, south, log)
        out_dsf = os.path.join(work, os.path.basename(path))
        subprocess.check_call([dsf_tool(), "--text2dsf", out_txt, out_dsf], stdout=subprocess.DEVNULL)
        store_dsf(out_dsf, path, True)
        log("malha gravada em " + os.path.basename(path))
    finally:
        shutil.rmtree(work, ignore_errors=True)


PROJETO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OSM_DIR = os.path.join(PROJETO, "osm")
EDITOR_DIR = os.path.join(PROJETO, "editor")
CONFIG_PATH = os.path.join(PROJETO, "config.json")
PASTA_PADRAO = r"D:\SteamLibrary\steamapps\common\X-Plane 12\XPlane Map Enhancement Data"


def ler_config():
    if not os.path.isfile(CONFIG_PATH):
        return {"pasta": PASTA_PADRAO}
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {"pasta": PASTA_PADRAO}
    if not data.get("pasta"):
        data["pasta"] = PASTA_PADRAO
    return data


def gravar_config(pasta):
    with open(CONFIG_PATH, "w", encoding="utf-8") as handle:
        json.dump({"pasta": pasta}, handle, ensure_ascii=False, indent=2)


def dsfs_do_osm(folder, osm):
    flats, ramps, _bounds = load_patch(osm)
    dsfs = find_dsfs(folder)
    south = [path for path in dsfs if "XPME_South_America" in path]
    if south:
        dsfs = south
    hit = []
    for path in dsfs:
        lat, lon = tile_of(path)
        tile = box(lon, lat, lon + 1, lat + 1)
        covers = any(poly.intersects(tile) for poly, _alt in flats) or any(
            poly.intersects(tile) for poly, *_rest in ramps
        )
        if covers:
            hit.append(path)
    return hit


def recuperar(folder, osm, log):
    paths = dsfs_do_osm(folder, osm)
    if not paths:
        raise RuntimeError("nenhum DSF cobre a area desse OSM")
    restored = 0
    for path in paths:
        backup = path + ".antes_osm"
        if not os.path.isfile(backup):
            log("sem backup: " + path)
            continue
        shutil.copy2(backup, path)
        log("recuperado " + os.path.basename(path))
        restored += 1
    if not restored:
        raise RuntimeError("os tiles desse OSM ainda nao tem backup")
    return restored


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
    if not porta_aberta(8767):
        subprocess.Popen(
            ["py", "-3.12", os.path.join(EDITOR_DIR, "servir-editor.py")],
            cwd=EDITOR_DIR,
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
    webbrowser.open("http://127.0.0.1:8767/editor.html")


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("OsmTerreno")
        self.geometry("760x520")
        self.folder = tk.StringVar(value=ler_config()["pasta"])
        self.busy = False
        pad = {"padx": 8, "pady": 4}
        frm = ttk.Frame(self)
        frm.pack(fill="x", **pad)
        ttk.Label(frm, text="Pasta dos terrenos").grid(row=0, column=0, sticky="w")
        ttk.Entry(frm, textvariable=self.folder, width=78).grid(row=1, column=0, sticky="we")
        ttk.Button(frm, text="Pasta...", command=self.pick_folder).grid(row=1, column=1, padx=6)
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
        ttk.Button(botoes, text="Importar", command=self.importar).pack(side="left", padx=(0, 4))
        ttk.Button(botoes, text="Exportar", command=self.exportar).pack(side="left", padx=4)
        ttk.Button(botoes, text="Apagar", command=self.apagar).pack(side="left", padx=4)
        ttk.Button(botoes, text="Editar", command=self.editar).pack(side="left", padx=4)
        ttk.Button(botoes, text="Selecionar tudo", command=self.marcar_todos).pack(side="left", padx=4)
        ttk.Button(botoes, text="Desmarcar tudo", command=self.desmarcar_todos).pack(side="left", padx=4)

        acoes = ttk.Frame(body)
        acoes.pack(side="left", fill="y", padx=(10, 0))
        ttk.Button(acoes, text="Compilar", command=self.compilar).pack(fill="x", pady=4)
        ttk.Button(acoes, text="Recuperar", command=self.recuperar_click).pack(fill="x", pady=4)

        self.log = tk.Text(self, height=12, wrap="word")
        self.log.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.recarregar()

    def pick_folder(self):
        path = filedialog.askdirectory(initialdir=self.folder.get() or "D:\\")
        if path:
            self.folder.set(path)
            gravar_config(path)

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
        gravar_config(folder)
        self.busy = True
        self.log.delete("1.0", "end")

        def trabalho():
            try:
                for origem in origens:
                    self.write(os.path.basename(origem))
                    func(folder, origem, self.write)
            except Exception as exc:
                self.after(0, lambda exc=exc: self.write("erro: " + str(exc)))
                self.after(0, lambda exc=exc: messagebox.showerror("OsmTerreno", str(exc)))
            else:
                self.after(0, lambda: messagebox.showinfo("OsmTerreno", "Concluido. Reinicie o X-Plane para ver."))
            finally:
                self.after(0, self._liberar)

        threading.Thread(target=trabalho, daemon=True).start()

    def _liberar(self):
        self.busy = False

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


if __name__ == "__main__":
    App().mainloop()
