/* OrthoForge patch OSM editor */
(function () {
  "use strict";

  const SNAP_PX = 16;
  const PALETTE = [
    "#2166ac", "#4393c3", "#92c5de", "#d1e5f0",
    "#fddbc7", "#f4a582", "#d6604d", "#b2182b", "#8e0152"
  ];
  const KIND_COLOR = {
    ramp: "#ffb020", water: "#3d8fff", waterway: "#5ec8ff",
    dummy: "#9aa8c0", rel: "#c084fc", shift: "#f472b6", other: "#8899aa"
  };
  const STRIP_KEYS = [
    "altitude", "altitude_high", "altitude_low", "cst_alt_abs", "cst_alt_rel",
    "var_alt_rel", "cell_size", "profile", "steepness", "natural", "waterway",
    "width", "of:width", "of:attr"
  ];
  const LINE_KINDS = { waterway: 1, dummy: 1 };
  const MODE_HINT = {
    select: "Clique numa área. Shift+clique escolhe a segunda. W une; J cria rampa.",
    insert: "Clique numa aresta para inserir vértice.",
    measure: "Clique pontos para medir. Enter limpa.",
    elev: "Clique no mapa para amostrar altitude (Open-Meteo DEM).",
    draw: "Clique vértices. Enter fecha, clique no 1º ponto fecha o polígono. O fecha como anel.",
    rect: "Retângulo: 2 cliques na base, 3º define a profundidade.",
    join: "Aresta: 2 vértices ou a aresta em cada área. Enter cria rampa/ligação.",
    split: "Nós: no anel clique 2 nós (não vizinhos). Linha: 1 nó interior. Enter divide.",
    merge: "Área: clique a primeira, depois a segunda (2 nós comuns). Enter une numa só."
  };
  const SEL_HINT = {
    area: "Modo área. Shift+clique na segunda e W une numa só. J cria rampa.",
    edge: "Modo aresta. Clique a borda e arraste — os dois nós andam juntos. Setas também movem.",
    node: "Modo nós. Arraste vértices. X divide o anel em 2 nós."
  };

  let OSM_FILE = "SBSP4.patch.osm";
  let lastAlts = [];
  let rectPreview = null;
  let OSM_ABS = "";
  let diskHandle = null;
  let TILE = { lat: -24, lon: -47 };

  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Esri" });
  const osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "© OSM" });
  const topo = L.tileLayer(
    "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    { maxZoom: 17, attribution: "OpenTopoMap" });

  const map = L.map("map", {
    zoomControl: true, maxZoom: 19, doubleClickZoom: true,
    closePopupOnClick: false, bounceAtZoomLimits: false
  }).setView([-23.626, -46.655], 14);
  sat.addTo(map);
  L.control.scale({ metric: true, imperial: false }).addTo(map);
  map.createPane("edgePane");
  map.getPane("edgePane").classList.add("edge-pane");
  map.getPane("edgePane").style.zIndex = 620;
  map.createPane("vertsPane");
  map.getPane("vertsPane").classList.add("verts-pane");
  map.getPane("vertsPane").style.zIndex = 650;

  (function enableExtraPan(map) {
    const el = map.getContainer();
    let pan = null;
    let usedRight = false;
    function startPan(e) {
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      el.classList.add("panning");
    }
    el.addEventListener("pointerdown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        startPan(e);
        return;
      }
      if (e.button === 2) {
        e.preventDefault();
        usedRight = false;
        startPan(e);
        return;
      }
      if (e.button === 0 && spaceDown) {
        e.preventDefault();
        e.stopPropagation();
        startPan(e);
      }
    }, true);
    el.addEventListener("pointermove", (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      e.preventDefault();
      const dx = pan.x - e.clientX, dy = pan.y - e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 1) usedRight = true;
      map.panBy([dx, dy], { animate: false, noMoveStart: true });
      pan.x = e.clientX;
      pan.y = e.clientY;
    }, true);
    function endPan(e) {
      if (!pan || (e.pointerId != null && e.pointerId !== pan.id)) return;
      pan = null;
      el.classList.remove("panning");
      map.dragging.enable();
    }
    el.addEventListener("pointerup", endPan, true);
    el.addEventListener("pointercancel", endPan, true);
    el.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); }, true);
    el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }, true);
    el.addEventListener("contextmenu", (e) => {
      if (usedRight) { e.preventDefault(); usedRight = false; }
    });
  })(map);

  window.addEventListener("mouseup", () => { map.dragging.enable(); });

  const overlay = L.featureGroup().addTo(map);
  const snapLayer = L.featureGroup().addTo(map);
  const verts = L.layerGroup().addTo(map);
  const draftLayer = L.featureGroup().addTo(map);
  const measureLayer = L.featureGroup().addTo(map);
  const refLayer = L.featureGroup();
  let tileRect = null;

  let nodes = {};
  let ways = [];
  let rels = [];
  let lastXml = "";
  let liveTimer = null;
  let liveOn = false;
  let didFit = false;
  let dirty = false;
  let mode = "select";
  let selKind = "area";
  let drawKind = "flat";
  let draft = [];
  let measurePts = [];
  let selectedId = null;
  let selectedId2 = null;
  let selectedNode = null;
  let selectedEdge = null;
  let edgeDrag = null;
  let edgeJustDragged = false;
  let edgeUi = null;
  let nextId = -1;
  let snapOn = true;
  let hoverSnap = null;
  let insertPreview = null;
  let undoStack = [];
  let redoStack = [];
  let vis = { flat: true, abs: true, ramp: true, water: true, waterway: true, dummy: true, rel: true, shift: true, other: true };
  let lastAlt = "783";
  let refOn = false;
  let showLabels = true;
  let joinOrder = [];
  let joinNodes = {};
  let splitPicks = [];
  let tagClip = null;
  let spaceDown = false;
  let spacePan = null;

  function $(id) { return document.getElementById(id); }
  function toast(msg, kind) {
    if ($("toolHint")) $("toolHint").textContent = msg;
    const t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "show" + (kind ? " " + kind : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ""; }, 2800);
  }
  function setModeLabel() {
    const names = {
      select: "sel " + (selKind === "edge" ? "aresta" : (selKind === "node" ? "nós" : "área")),
      insert: "+ vértice", measure: "medir", elev: "amostrar m",
      draw: "desenhar " + drawKind, rect: "retângulo " + drawKind, join: "juntar arestas",
      split: "dividir 2 nós", merge: "unir áreas"
    };
    $("modeLabel").textContent = names[mode] || mode;
    if ($("snapLabel")) $("snapLabel").textContent = snapOn ? "snap on" : "snap off";
    if ($("zoomLabel")) $("zoomLabel").textContent = "z" + map.getZoom();
  }
  function syncSelButtons() {
    const on = (k) => {
      if (mode === "merge") return k === "area";
      if (mode === "join" || mode === "insert") return k === "edge";
      if (mode === "split") return k === "node";
      if (mode === "select") return k === selKind;
      return false;
    };
    document.querySelectorAll("[data-sel]").forEach((b) => {
      b.classList.toggle("active", on(b.getAttribute("data-sel")));
    });
  }
  function setSelKind(k) {
    selKind = k;
    if (k === "area") { selectedNode = null; selectedEdge = null; }
    if (k === "node") selectedEdge = null;
    if (k === "edge") selectedNode = null;
    if (mode !== "select" && mode !== "merge") setMode("select");
    else {
      syncSelButtons();
      setModeLabel();
      draw({ fit: false });
    }
    const hints = {
      area: SEL_HINT.area,
      edge: SEL_HINT.edge,
      node: SEL_HINT.node
    };
    toast(hints[k] || "");
  }
  function num(v) {
    if (v == null || v === "") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  function isClosed(nd) { return nd.length > 2 && nd[0] === nd[nd.length - 1]; }
  function uniqueNd(nd) { return isClosed(nd) ? nd.slice(0, -1) : nd.slice(); }
  function getWay(id) { return ways.find((w) => w.id === id); }
  function ll(id) { const n = nodes[id]; return n ? [n.lat, n.lon] : null; }
  function wayVisible(w) { return vis[w.kind] !== false; }

  function classify(tags) {
    const t = tags || {};
    if (String(t["of:attr"] || "").toUpperCase() === "WATER") return "water";
    if (t.natural === "water" || t.waterway === "riverbank" || t.waterway === "dock") return "water";
    if (t.waterway) return "waterway";
    if (t.altitude_high != null && t.altitude_high !== "") return "ramp";
    if (t.cst_alt_abs != null && t.cst_alt_abs !== "") return "abs";
    if (t.cst_alt_rel != null && t.cst_alt_rel !== "") return "rel";
    if (t.var_alt_rel != null && t.var_alt_rel !== "") return "shift";
    if (t.altitude != null && t.altitude !== "") return "flat";
    if (!Object.keys(t).length) return "dummy";
    return "other";
  }

  function enrich(way) {
    way.kind = classify(way.tags);
    way.closed = isClosed(way.nd);
    way.ids = new Set(way.nd);
    way.latlngs = way.nd.map(ll).filter(Boolean);
    way.alt = num(way.tags.altitude != null ? way.tags.altitude : way.tags.cst_alt_abs);
    way.altHi = num(way.tags.altitude_high);
    way.altLo = num(way.tags.altitude_low);
    return way;
  }

  function wayLabel(w) {
    switch (w.kind) {
      case "ramp": return (w.altHi != null ? w.altHi : "?") + "→" + (w.altLo != null ? w.altLo : "?");
      case "flat":
      case "abs": return w.alt != null ? w.alt + " m" : "flat";
      case "rel": return "rel " + (w.tags.cst_alt_rel || "0");
      case "shift": return "Δ " + (w.tags.var_alt_rel || "0");
      case "water": return "água";
      case "waterway": return w.tags.waterway || "curso";
      case "dummy": return "dummy";
      default: return Object.keys(w.tags)[0] || w.id;
    }
  }

  function defaultTags(kind, extra) {
    extra = extra || {};
    switch (kind) {
      case "flat": return { altitude: extra.alt != null ? String(extra.alt) : lastAlt, cell_size: extra.cell || "2" };
      case "abs": return { cst_alt_abs: extra.alt != null ? String(extra.alt) : lastAlt, cell_size: extra.cell || "2" };
      case "rel": return { cst_alt_rel: extra.rel != null ? String(extra.rel) : "0" };
      case "shift": return { var_alt_rel: extra.shift != null ? String(extra.shift) : "0" };
      case "ramp": return {
        altitude_high: extra.hi != null ? String(extra.hi) : "",
        altitude_low: extra.lo != null ? String(extra.lo) : "",
        cell_size: extra.cell || "2",
        profile: extra.profile || "spline"
      };
      case "water": return { natural: "water" };
      case "waterway": {
        const t = { waterway: extra.ww || $("edWw").value || "drain" };
        if (extra.width) t.width = String(extra.width);
        return t;
      }
      default: return {};
    }
  }

  function metres(a, b) {
    const lat = (a[0] + b[0]) / 2 * Math.PI / 180;
    return Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos(lat));
  }
  function toXY(lat, lon, lat0) {
    return { x: lon * 111320 * Math.cos(lat0 * Math.PI / 180), y: lat * 111320 };
  }
  function fromXY(x, y, lat0) {
    return { lat: y / 111320, lon: x / (111320 * Math.cos(lat0 * Math.PI / 180)) };
  }
  function azimuth(a, b) {
    const lat1 = a[0] * Math.PI / 180, lat2 = b[0] * Math.PI / 180;
    const dLon = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function centroid(latlngs) {
    let lat = 0, lon = 0;
    const n = latlngs.length - (latlngs.length > 1 && latlngs[0][0] === latlngs[latlngs.length - 1][0] && latlngs[0][1] === latlngs[latlngs.length - 1][1] ? 1 : 0);
    const m = n < 1 ? latlngs.length : n;
    for (let i = 0; i < m; i++) { lat += latlngs[i][0]; lon += latlngs[i][1]; }
    return [lat / m, lon / m];
  }
  function approxAreaM2(latlngs) {
    if (latlngs.length < 3) return 0;
    const lat0 = latlngs[0][0] * Math.PI / 180;
    const mLat = 111320, mLon = 111320 * Math.cos(lat0);
    let a = 0;
    for (let i = 0; i < latlngs.length - 1; i++) {
      const x1 = latlngs[i][1] * mLon, y1 = latlngs[i][0] * mLat;
      const x2 = latlngs[i + 1][1] * mLon, y2 = latlngs[i + 1][0] * mLat;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }
  function fmtCoord(x) {
    return Number(x).toFixed(11).replace(/0+$/, "").replace(/\.$/, "");
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }

  function snapshot() {
    return JSON.stringify({
      nodes: nodes,
      ways: ways.map((w) => ({ id: w.id, nd: w.nd.slice(), tags: Object.assign({}, w.tags) })),
      rels: rels,
      nextId: nextId
    });
  }
  function restore(json) {
    const s = JSON.parse(json);
    nodes = s.nodes;
    rels = s.rels || [];
    nextId = s.nextId;
    ways = s.ways.map((w) => enrich({ id: w.id, nd: w.nd.slice(), tags: Object.assign({}, w.tags) }));
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack = [];
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    markDirty(true);
    draw({ fit: false });
    if (selectedId) selectWay(selectedId, true);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    markDirty(true);
    draw({ fit: false });
    if (selectedId) selectWay(selectedId, true);
  }

  function allocId() {
    const id = String(nextId);
    nextId -= 1;
    return id;
  }
  function refreshNextId() {
    const ids = Object.keys(nodes).map(Number)
      .concat(ways.map((w) => Number(w.id)))
      .concat(rels.map((r) => Number(r.id)));
    nextId = ids.length ? Math.min.apply(null, ids) - 1 : -1;
    if (nextId >= 0) nextId = -1;
  }

  function nodeUseCount(id) {
    let n = 0;
    ways.forEach((w) => { if (w.ids && w.ids.has(id)) n++; });
    draft.forEach((p) => { if (p.id === id) n++; });
    return n;
  }
  function pruneOrphans() {
    const used = new Set();
    ways.forEach((w) => w.nd.forEach((id) => used.add(id)));
    rels.forEach((r) => r.members.forEach((m) => { if (m.type === "node") used.add(m.ref); }));
    Object.keys(nodes).forEach((id) => {
      if (!used.has(id) && (!nodes[id].tags || !Object.keys(nodes[id].tags).length)) delete nodes[id];
    });
  }
  function mergeNode(fromId, toId) {
    if (fromId === toId) return;
    const ft = nodes[fromId] && nodes[fromId].tags;
    if (ft && nodes[toId]) {
      nodes[toId].tags = nodes[toId].tags || {};
      Object.keys(ft).forEach((k) => {
        if (nodes[toId].tags[k] == null) nodes[toId].tags[k] = ft[k];
      });
    }
    ways.forEach((w) => {
      const mapped = w.nd.map((id) => (id === fromId ? toId : id));
      const closed = mapped.length > 2 && mapped[0] === mapped[mapped.length - 1];
      const out = [mapped[0]];
      for (let i = 1; i < mapped.length; i++) {
        if (mapped[i] !== out[out.length - 1]) out.push(mapped[i]);
      }
      if (closed && out[0] !== out[out.length - 1]) out.push(out[0]);
      w.nd = out;
    });
    delete nodes[fromId];
    ways = ways.filter((w) => uniqueNd(w.nd).length >= 2);
    ways.forEach(enrich);
  }

  function snapNode(lat, lon, exclude) {
    if (!snapOn) return null;
    const origin = map.latLngToLayerPoint([lat, lon]);
    let best = null, bestD = SNAP_PX;
    Object.keys(nodes).forEach((id) => {
      if (exclude && exclude.has(id)) return;
      const n = nodes[id];
      const d = origin.distanceTo(map.latLngToLayerPoint([n.lat, n.lon]));
      if (d < bestD) { bestD = d; best = { id: id, lat: n.lat, lon: n.lon }; }
    });
    return best;
  }

  function ensureNode(p) {
    if (p.id && nodes[p.id]) return p.id;
    const hit = snapOn ? snapNode(p.lat, p.lon) : null;
    if (hit) return hit.id;
    const id = allocId();
    nodes[id] = { lat: p.lat, lon: p.lon, tags: {} };
    return id;
  }

  function colorFor(alt, alts) {
    if (alt == null) return KIND_COLOR.other;
    const i = alts.indexOf(alt);
    return PALETTE[Math.min(Math.max(i, 0), PALETTE.length - 1)];
  }
  function wayColor(way, alts) {
    if (way.kind === "flat" || way.kind === "abs") return colorFor(way.alt, alts);
    return KIND_COLOR[way.kind] || KIND_COLOR.other;
  }

  function shareCount(A, B) {
    let n = 0;
    A.ids.forEach((id) => { if (B.ids.has(id)) n++; });
    return n;
  }
  function ringDist(A, B, stopAt) {
    let m = Infinity;
    const limit = stopAt == null ? 0 : stopAt;
    const as = A.latlngs, bs = B.latlngs;
    for (let i = 0; i < as.length; i++) {
      for (let j = 0; j < bs.length; j++) {
        m = Math.min(m, metres(as[i], bs[j]));
        if (m <= limit) return m;
      }
    }
    return m;
  }
  function ringBbox(way) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    way.latlngs.forEach((p) => {
      if (p[0] < minLat) minLat = p[0];
      if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLon) minLon = p[1];
      if (p[1] > maxLon) maxLon = p[1];
    });
    return { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon };
  }
  function bboxGapM(a, b) {
    const lat0 = (a.minLat + a.maxLat) * 0.5;
    const my = 111320;
    const mx = my * Math.cos(lat0 * Math.PI / 180);
    const dy = a.maxLat < b.minLat ? (b.minLat - a.maxLat) * my : (b.maxLat < a.minLat ? (a.minLat - b.maxLat) * my : 0);
    const dx = a.maxLon < b.minLon ? (b.minLon - a.maxLon) * mx : (b.maxLon < a.minLon ? (a.minLon - b.maxLon) * mx : 0);
    return Math.hypot(dx, dy);
  }
  function rampBridges(A, B) {
    return ways.filter((r) => {
      if (r.kind !== "ramp") return false;
      const touchesBoth = shareCount(r, A) > 0 && shareCount(r, B) > 0;
      const hi = r.altHi, lo = r.altLo;
      const matchAlts =
        (hi != null && lo != null && A.alt != null && B.alt != null) &&
        ((Math.abs(hi - A.alt) < 0.6 && Math.abs(lo - B.alt) < 0.6) ||
         (Math.abs(hi - B.alt) < 0.6 && Math.abs(lo - A.alt) < 0.6));
      return touchesBoth || (matchAlts && (shareCount(r, A) + shareCount(r, B) > 0));
    });
  }
  function findCliffs() {
    const flats = ways.filter((w) => (w.kind === "flat" || w.kind === "abs") && w.alt != null);
    const out = [];
    for (let i = 0; i < flats.length; i++) {
      for (let j = i + 1; j < flats.length; j++) {
        const A = flats[i], B = flats[j];
        const d = Math.abs(A.alt - B.alt);
        if (d < 2.5) continue;
        const share = shareCount(A, B);
        if (share < 1 && bboxGapM(ringBbox(A), ringBbox(B)) > 15) continue;
        const dist = share >= 1 ? 0 : ringDist(A, B, 15);
        if (share < 1 && dist > 15) continue;
        out.push({ a: A, b: B, d: d, share: share, dist: dist, ramps: rampBridges(A, B) });
      }
    }
    out.sort((x, y) => y.d - x.d);
    return out;
  }

  function popupHtml(way) {
    const tags = Object.keys(way.tags).map((k) => k + "=" + way.tags[k]).join("<br>");
    const area = approxAreaM2(way.latlngs);
    const areaTxt = area > 1e6 ? (area / 1e6).toFixed(2) + " km²" : Math.round(area) + " m²";
    const c = centroid(way.latlngs);
    let warn = "";
    if (way.kind === "ramp" && uniqueNd(way.nd).length !== 4) {
      warn = "<div style='color:#c60'>OrthoForge ignora rampa que não tenha 4 cantos.</div>";
    }
    return "<div class='popup-alt'>" + wayLabel(way) + "</div>" +
      "way " + way.id + " · " + way.kind + (way.closed ? " · anel" : " · linha") + "<br>" +
      areaTxt + " · " + way.nd.length + " nd<br>" +
      "<code>" + c[0].toFixed(6) + ", " + c[1].toFixed(6) + "</code>" + warn +
      "<div style='margin-top:6px;color:#555'>" + (tags || "<i>sem tags</i>") + "</div>";
  }

  function draw(opts) {
    opts = opts || {};
    overlay.clearLayers();
    ways.forEach(enrich);
    const alts = [...new Set(ways.map((w) => w.alt).filter((a) => a != null))].sort((a, b) => a - b);
    lastAlts = alts;
    const fillOp = $("op").value / 100;
    const q = ($("search").value || "").toLowerCase();

    ways.forEach((way) => {
      if (!wayVisible(way) || way.latlngs.length < 2) return;
      const col = wayColor(way, alts);
      const sel = way.id === selectedId || way.id === selectedId2;
      const isRamp = way.kind === "ramp";
      const isLine = !way.closed || LINE_KINDS[way.kind];
      const style = {
        color: way.id === selectedId ? "#fff" : (way.id === selectedId2 ? "#ffe08a" : col),
        weight: sel ? 3.5 : (isRamp || way.kind === "waterway" ? 2.5 : 2),
        fillColor: col,
        fillOpacity: (!isLine && way.closed) ? (isRamp ? fillOp * 0.65 : fillOp) : 0,
        dashArray: isRamp || way.kind === "dummy" ? "6 4" : null
      };
      const layer = (!isLine && way.closed) ? L.polygon(way.latlngs, style) : L.polyline(way.latlngs, style);
      if (mode === "select" && selKind === "edge") layer.options.bubblingMouseEvents = false;
      layer.bindTooltip(wayLabel(way), { sticky: true, direction: "top", opacity: 0.85 });
      layer.on("mouseover", () => {
        if (way.id !== selectedId && way.id !== selectedId2 && layer.setStyle) {
          layer.setStyle({ weight: (style.weight || 2) + 1.2 });
        }
      });
      layer.on("mouseout", () => {
        if (way.id !== selectedId && way.id !== selectedId2 && layer.setStyle) layer.setStyle({ weight: style.weight });
      });
      layer.on("mousedown", (ev) => {
        if (mode !== "select" || selKind !== "edge") return;
        if (ev.originalEvent && ev.originalEvent.button !== 0) return;
        if (spaceDown) return;
        L.DomEvent.stop(ev);
        if (ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
        beginEdgeMove(way, ev.latlng, ev.originalEvent);
      });
      layer.on("click", (ev) => {
        L.DomEvent.stop(ev);
        if (ev.originalEvent && ev.originalEvent.button === 1) return;
        if (mode === "draw" || mode === "rect") { addDraftPoint(ev.latlng); return; }
        if (mode === "insert") { insertAt(ev.latlng, way); return; }
        if (mode === "measure") { addMeasure(ev.latlng); return; }
        if (mode === "join") { joinClickOnWay(way, ev.latlng); return; }
        if (mode === "split") { splitClickOnWay(way, ev.latlng); return; }
        if (mode === "merge") { pickMergeWay(way); return; }
        if (mode === "select" && selKind === "edge") {
          if (edgeJustDragged) { edgeJustDragged = false; return; }
          return;
        }
        if (ev.originalEvent && ev.originalEvent.shiftKey) {
          selectedId2 = way.id;
          draw({ fit: false });
          updateMergeBanner();
          toast("Segunda área " + way.id + ". W une numa só · J cria rampa.");
          return;
        }
        selectedId2 = null;
        selectedEdge = null;
        selectWay(way.id);
      });
      overlay.addLayer(layer);
      way._layer = layer;

      if (isRamp && uniqueNd(way.nd).length >= 4 && way.closed) {
        const nd = way.nd;
        const low = [ll(nd[1]), ll(nd[2])].filter(Boolean);
        const high = [ll(nd[nd.length - 2]), ll(nd[nd.length - 1])].filter(Boolean);
        if (low.length === 2) {
          L.polyline(low, { color: "#7ec8ff", weight: 4, interactive: false }).addTo(overlay);
          if (showLabels) {
            L.marker([(low[0][0] + low[1][0]) / 2, (low[0][1] + low[1][1]) / 2], {
              icon: L.divIcon({ className: "", html: "<div class='edge-label' style='border-color:#7ec8ff'>LOW</div>", iconSize: [36, 14], iconAnchor: [18, 7] }),
              interactive: false
            }).addTo(overlay);
          }
        }
        if (high.length === 2) {
          L.polyline(high, { color: "#ff6b7a", weight: 4, interactive: false }).addTo(overlay);
          if (showLabels) {
            L.marker([(high[0][0] + high[1][0]) / 2, (high[0][1] + high[1][1]) / 2], {
              icon: L.divIcon({ className: "", html: "<div class='edge-label' style='border-color:#ff6b7a'>HIGH</div>", iconSize: [40, 14], iconAnchor: [20, 7] }),
              interactive: false
            }).addTo(overlay);
          }
        }
      }

      if (showLabels) {
        const c = centroid(way.latlngs);
        const label = L.marker(c, {
          icon: L.divIcon({
            className: "",
            html: "<div style='background:#0c1222ee;color:#fff;border:1px solid " + col +
              ";padding:1px 5px;border-radius:4px;font:11px ui-monospace,monospace;white-space:nowrap;cursor:text'>" +
              wayLabel(way) + "</div>",
            iconSize: [86, 18], iconAnchor: [43, 9]
          }),
          interactive: true
        });
        label.on("click", (ev) => {
          L.DomEvent.stop(ev);
          selectedId2 = null;
          selectedEdge = null;
          selectWay(way.id);
        });
        label.addTo(overlay);
      }
    });

    drawVerts();
    drawSelectedEdge();
    renderLegend(alts, q);
    renderCliffs();
    renderStatus(opts, alts);
    if (mode === "join") previewJoin();
    if (mode === "split") previewSplit();
    if (mode === "merge" || (mode === "select" && selKind === "area" && selectedId2)) previewMerge();

    if (opts.fit && overlay.getLayers().length) {
      map.fitBounds(overlay.getBounds().pad(0.08));
      didFit = true;
    }
  }

  function renderLegend(alts, q) {
    const legend = $("legend");
    legend.innerHTML = "";
    const names = { flat: "Flatten", abs: "Flatten abs", ramp: "Rampas", water: "Água", waterway: "Cursos", rel: "Relativo", shift: "Shift", dummy: "Dummy", other: "Outros" };
    const order = ["ramp", "flat", "abs", "water", "waterway", "rel", "shift", "dummy", "other"];
    const groups = {};
    ways.forEach((w) => {
      const k = w.kind || "other";
      (groups[k] || (groups[k] = [])).push(w);
    });
    if ($("objCount")) $("objCount").textContent = String(ways.length);
    order.forEach((k) => {
      const list = groups[k];
      if (!list || !list.length) return;
      const h = document.createElement("div");
      h.className = "group-h";
      h.textContent = (names[k] || k) + " · " + list.length;
      legend.appendChild(h);
      list.sort((a, b) => (a.alt ?? 0) - (b.alt ?? 0)).forEach((way) => {
        const blob = (wayLabel(way) + " " + way.id + " " + JSON.stringify(way.tags)).toLowerCase();
        if (q && blob.indexOf(q) < 0) return;
        const col = wayColor(way, alts);
        const el = document.createElement("div");
        el.dataset.way = String(way.id);
        el.className = "swatch" + (way.id === selectedId || way.id === selectedId2 ? " on" : "") + (wayVisible(way) ? "" : " dim");
        el.innerHTML = "<span class='dot' style='background:" + col + "'></span><span>" +
          wayLabel(way) + " <span class='muted'>" + way.id + "</span></span>";
        el.onclick = () => {
          if (way._layer) map.fitBounds(way._layer.getBounds().pad(0.3));
          selectWay(way.id);
        };
        legend.appendChild(el);
      });
    });
  }

  function renderCliffs() {
    const box = $("cliffs");
    box.innerHTML = "";
    const cliffs = findCliffs();
    const open = cliffs.filter((c) => !c.ramps.length);
    const bridged = cliffs.filter((c) => c.ramps.length);
    const rampBad = ways.filter((w) => w.kind === "ramp" && uniqueNd(w.nd).length !== 4);
    function addIssue(html, cls, onClick) {
      const b = document.createElement("button");
      b.className = "issue" + (cls ? " " + cls : "");
      b.innerHTML = html;
      if (onClick) b.onclick = onClick;
      box.appendChild(b);
    }
    rampBad.forEach((w) => addIssue("Rampa " + w.id + " inválida (≠4 cantos)", "", () => selectWay(w.id)));
    open.forEach((c) => addIssue(
      "Degrau Δ " + c.d.toFixed(0) + " m · " + c.a.alt + " ↔ " + c.b.alt +
      "<br><span class='muted'>" + c.a.id + " — " + c.b.id + "</span>",
      "",
      () => { selectedId2 = c.b.id; selectWay(c.a.id); }
    ));
    bridged.forEach((c) => addIssue(
      "Rampa ok Δ " + c.d.toFixed(0) + " m · " + c.a.id + " ↔ " + c.b.id, "okish",
      () => { selectedId2 = c.b.id; selectWay(c.a.id); }
    ));
    if (!box.childNodes.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Nenhum degrau aberto nem rampa inválida.";
      box.appendChild(p);
    }
  }

  function renderStatus(opts, alts) {
    const when = new Date().toLocaleTimeString("pt-BR", { hour12: false });
    const flats = ways.filter((w) => w.kind === "flat" || w.kind === "abs").length;
    const ramps = ways.filter((w) => w.kind === "ramp").length;
    $("statLine").innerHTML =
      "<span class='ok'>" + ways.length + " ways</span> · " +
      flats + " flatten · " + ramps + " rampas · " + Object.keys(nodes).length + " nós" +
      (alts.length ? " · " + alts[0] + "–" + alts[alts.length - 1] + " m" : "") +
      (dirty ? " · <span class='dirty'>não salvo</span>" : " · salvo") +
      (liveOn ? " · ao vivo" : "") +
      " · " + when;
    $("fileLabel").textContent = fileBase() + (dirty ? " *" : "");
    if ($("savePath")) {
      $("savePath").textContent = OSM_ABS || OSM_FILE;
      $("savePath").title = "Ctrl+S grava neste arquivo";
    }
    document.title = (dirty ? "● " : "") + fileBase() + " · Patch Editor";
    if ($("btnSave")) $("btnSave").classList.toggle("primary", dirty);
    setModeLabel();
  }

  function drawVerts() {
    verts.clearLayers();
    const showNodes = mode === "join" || mode === "split" || mode === "insert"
      || (mode === "select" && selKind === "node")
      || (mode === "select" && selKind === "edge");
    if (!showNodes) return;
    const selected = getWay(selectedId);
    const ids = new Set();
    if (mode === "join") {
      ways.filter(wayVisible).forEach((w) => uniqueNd(w.nd).forEach((id) => ids.add(id)));
    } else if (mode === "split") {
      if (selected) uniqueNd(selected.nd).forEach((id) => ids.add(id));
      else ways.filter(wayVisible).forEach((w) => uniqueNd(w.nd).forEach((id) => ids.add(id)));
    } else if (mode === "select" && selKind === "edge") {
      if (selectedEdge) { ids.add(selectedEdge.a); ids.add(selectedEdge.b); }
      else if (selected) uniqueNd(selected.nd).forEach((id) => ids.add(id));
    } else if (selected) selected.nd.forEach((id) => ids.add(id));
    else if (mode === "select" && selKind === "node") Object.keys(nodes).forEach((id) => ids.add(id));
    const joinIndex = {};
    if (mode === "join") {
      joinOrder.forEach((wid, wi) => {
        (joinNodes[wid] || []).forEach((nid, ni) => {
          joinIndex[nid] = (wi === 0 ? "A" : "B") + (ni + 1);
        });
      });
    }
    ids.forEach((id) => {
      if (!nodes[id]) return;
      const shared = nodeUseCount(id) > 1;
      const selN = id === selectedNode;
      const splitIx = mode === "split" ? splitPicks.indexOf(id) : -1;
      const picked = joinIndex[id] || (splitIx >= 0 ? String(splitIx + 1) : null);
      const size = picked ? 20 : (selN ? 20 : (selected && mode !== "join" && mode !== "split" ? 16 : 12));
      const bg = splitIx >= 0
        ? (splitIx === 0 ? "#ffb070" : "#ffe08a")
        : (picked
          ? (picked.charAt(0) === "A" ? "#ff6b7a" : "#7ec8ff")
          : (selN ? "#fff" : (shared ? "#7ec8ff" : "#3ddc97")));
      const inner = picked
        ? "<div class='vert-num' style='background:" + bg + "'>" + picked + "</div>"
        : "<div style='width:" + size + "px;height:" + size + "px;border-radius:50%;background:" +
          bg + ";border:2px solid " + (selN ? "#3ddc97" : "#fff") + ";box-shadow:0 0 0 1px #0008'></div>";
      const m = L.marker([nodes[id].lat, nodes[id].lon], {
        pane: "vertsPane",
        draggable: mode === "select" && (selKind === "node" || selKind === "edge"),
        autoPan: false,
        keyboard: false,
        zIndexOffset: 2000,
        icon: L.divIcon({
          className: "vert-handle",
          html: inner,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2]
        })
      });
      m.on("click", (ev) => {
        L.DomEvent.stop(ev);
        if (mode === "insert") return;
        if (ev.originalEvent && ev.originalEvent.button === 1) return;
        if (mode === "join") {
          pickJoinNode(id);
          return;
        }
        if (mode === "split") {
          pickSplitNode(id);
          return;
        }
        if (mode === "select" && selKind === "edge") {
          const way = ownerWay(id, selectedId);
          if (way) pickEdgeOnWay(way, L.latLng(nodes[id].lat, nodes[id].lon));
          return;
        }
        if (mode === "select" && selKind !== "node") return;
        if (mode === "select" && ev.originalEvent && ev.originalEvent.shiftKey && selectedNode && selectedNode !== id) {
          const way = ownerWay(id, selectedId);
          if (way && way.nd.indexOf(selectedNode) >= 0) {
            selectedId = way.id;
            splitPicks = [selectedNode, id];
            setMode("split");
            afterSplitPick();
            return;
          }
        }
        selectedNode = id;
        if (!selectedId) {
          const owner = ways.find((w) => w.nd.indexOf(id) >= 0);
          if (owner) selectedId = owner.id;
        }
        fillNodeForm(id);
        drawVerts();
      });
      m.on("mousedown", (ev) => {
        const btn = ev.originalEvent ? ev.originalEvent.button : 0;
        if (btn === 1) return;
        if (mode === "select" && (selKind === "node" || selKind === "edge")) map.dragging.disable();
      });
      m.on("dragstart", () => {
        pushUndo();
        map.closePopup();
        selectedNode = id;
        if (!selectedId) {
          const owner = ways.find((w) => w.nd.indexOf(id) >= 0);
          if (owner) selectedId = owner.id;
        }
      });
      m.on("drag", (ev) => {
        const hit = (selKind === "node" && snapOn) ? snapNode(ev.latlng.lat, ev.latlng.lng, new Set([id])) : null;
        const pos = hit ? L.latLng(hit.lat, hit.lon) : ev.latlng;
        if (hit) m.setLatLng(pos);
        nodes[id].lat = pos.lat;
        nodes[id].lon = pos.lng;
        m._snapTo = hit ? hit.id : null;
        const way = getWay(selectedId);
        if (way && way._layer && way._layer.setLatLngs) {
          way.latlngs = way.nd.map(ll).filter(Boolean);
          way._layer.setLatLngs(way.latlngs);
        }
        refreshEdgeGraphic();
      });
      m.on("dragend", () => {
        map.dragging.enable();
        if (m._snapTo) mergeNode(id, m._snapTo);
        markDirty();
        const keep = selectedId, keepN = m._snapTo || id;
        draw({ fit: false });
        if (keep) selectWay(keep, true);
        selectedNode = nodes[keepN] ? keepN : null;
        if (selectedNode) fillNodeForm(selectedNode);
      });
      verts.addLayer(m);
    });
  }

  function selectWay(id, keepForm) {
    if (mode === "split" && selectedId && selectedId !== id) splitPicks = [];
    selectedId = id;
    if (mode !== "split") selectedNode = null;
    const way = getWay(id);
    if (!way) return;
    map.closePopup();
    if (mode === "split") {
      $("inspEmpty").hidden = true;
      $("inspWay").hidden = true;
      $("inspJoin").hidden = true;
      if ($("inspSplit")) $("inspSplit").hidden = false;
      $("inspNode").hidden = true;
      renderSplitSlots();
      previewSplit();
      drawVerts();
      overlay.eachLayer((l) => {
        if (l.setStyle && way._layer === l) l.setStyle({ weight: 3.5, color: "#fff" });
      });
      return;
    }
    if (mode === "join") {
      drawVerts();
      return;
    }
    if (!keepForm) {
      fillForm(way);
      if ((way.kind === "flat" || way.kind === "abs") && $("edAlt")) {
        const altEl = $("edAlt");
        altEl.focus();
        altEl.select();
      }
    }
    $("inspEmpty").hidden = true;
    $("inspWay").hidden = false;
    if ($("inspSplit")) $("inspSplit").hidden = true;
    if ($("inspJoin")) $("inspJoin").hidden = true;
    updateMergeBanner();
    drawVerts();
    overlay.eachLayer((l) => {
      if (l.setStyle && way._layer === l) l.setStyle({ weight: 3.5, color: "#fff" });
    });
    document.querySelectorAll(".swatch").forEach((el) => {
      el.classList.toggle("on", el.dataset.way === String(id) || el.dataset.way === String(selectedId2));
    });
    drawSelectedEdge();
  }

  function fillForm(way) {
    $("edId").textContent = way.id + (way.closed ? " · anel" : " · linha") + " · " + way.nd.length + " nd";
    let k = way.kind;
    if (k === "abs" || k === "flat" || k === "rel" || k === "shift" || k === "ramp" || k === "water" || k === "waterway" || k === "dummy" || k === "other") {
      $("edKind").value = k;
    } else $("edKind").value = "other";
    $("edAlt").value = way.alt != null ? way.alt : "";
    $("edRel").value = way.tags.cst_alt_rel || "0";
    $("edShift").value = way.tags.var_alt_rel || "0";
    $("edHi").value = way.altHi != null ? way.altHi : "";
    $("edLo").value = way.altLo != null ? way.altLo : "";
    $("edCell").value = way.tags.cell_size || "2";
    $("edProf").value = way.tags.profile || "spline";
    $("edSteep").value = way.tags.steepness || "2";
    $("edWw").value = way.tags.waterway && $("edWw").querySelector("option[value='" + way.tags.waterway + "']") ? way.tags.waterway : (way.tags.waterway || "drain");
    $("edWidth").value = way.tags.width || way.tags["of:width"] || "";
    fillTagTable(way.tags);
    syncKindFields();
    $("inspNode").hidden = true;
    fillStats(way);
    if ($("btnClose")) $("btnClose").textContent = way.closed ? "Abrir anel" : "Fechar anel";
    updateMergeBanner();
  }

  function fillStats(way) {
    const el = $("wayStats");
    if (!el) return;
    const area = approxAreaM2(way.latlngs);
    let peri = 0;
    for (let i = 1; i < way.latlngs.length; i++) peri += metres(way.latlngs[i - 1], way.latlngs[i]);
    const areaTxt = area > 1e6 ? (area / 1e6).toFixed(2) + " km²" : Math.round(area) + " m²";
    const n = uniqueNd(way.nd).length;
    const dlt = (way.altHi != null && way.altLo != null) ? (way.altHi - way.altLo).toFixed(1) + " m" : "—";
    el.innerHTML =
      "<div><b>Área</b>" + areaTxt + "</div>" +
      "<div><b>Perímetro</b>" + peri.toFixed(0) + " m</div>" +
      "<div><b>Vértices</b>" + n + (way.closed ? " · anel" : " · linha") + "</div>" +
      "<div><b>Δ high/low</b>" + dlt + "</div>";
  }

  function fillNodeForm(id) {
    const n = nodes[id];
    if (!n) return;
    $("inspNode").hidden = false;
    $("ndId").textContent = id;
    $("ndLat").value = n.lat;
    $("ndLon").value = n.lon;
    $("ndAbs").value = (n.tags && n.tags.alt_abs) || "";
    $("ndRel").value = (n.tags && n.tags.alt_rel) || "";
    $("ndUse").textContent = "Usado em " + nodeUseCount(id) + " way(s). Azul = compartilhado.";
  }

  function fillTagTable(tags) {
    const tb = $("tagTable").querySelector("tbody");
    tb.innerHTML = "";
    Object.keys(tags).forEach((k) => addTagRow(k, tags[k]));
  }
  function addTagRow(k, v) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    const td2 = document.createElement("td");
    const td3 = document.createElement("td");
    const ik = document.createElement("input");
    const iv = document.createElement("input");
    const del = document.createElement("button");
    ik.value = k || "";
    iv.value = v || "";
    del.textContent = "×";
    del.onclick = () => tr.remove();
    td1.appendChild(ik);
    td2.appendChild(iv);
    td3.appendChild(del);
    tr.appendChild(td1);
    tr.appendChild(td2);
    tr.appendChild(td3);
    $("tagTable").querySelector("tbody").appendChild(tr);
  }
  function readTagTable() {
    const tags = {};
    $("tagTable").querySelectorAll("tbody tr").forEach((tr) => {
      const inputs = tr.querySelectorAll("input");
      const k = (inputs[0].value || "").trim();
      if (k) tags[k] = inputs[1].value;
    });
    return tags;
  }

  function syncKindFields() {
    const k = $("edKind").value;
    document.querySelectorAll("#inspWay .field, #inspWay .hint").forEach((el) => {
      const shows = [...el.classList].filter((c) => c.indexOf("show-") === 0).map((c) => c.slice(5));
      if (!shows.length) return;
      const on = shows.indexOf(k) >= 0;
      if (el.classList.contains("field")) el.style.display = on ? "grid" : "none";
      else el.style.display = on ? "block" : "none";
    });
  }

  function decField(v) {
    const s = String(v == null ? "" : v).trim().replace(/\s/g, "").replace(",", ".");
    if (!s) return "";
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : "";
  }

  function applyTags(opts) {
    const way = getWay(selectedId);
    if (!way) return;
    const kind = $("edKind").value;
    const alt = decField($("edAlt").value);
    const hi = decField($("edHi").value);
    const lo = decField($("edLo").value);
    if ((kind === "flat" || kind === "abs") && $("edAlt").value.trim() && !alt) {
      toast("Altitude inválida. Use 782.6 ou 782,6.", "warn");
      return;
    }
    pushUndo();
    const keep = readTagTable();
    STRIP_KEYS.forEach((k) => { delete keep[k]; });
    const extra = {
      alt: alt, rel: $("edRel").value, shift: $("edShift").value,
      hi: hi, lo: lo, cell: $("edCell").value,
      profile: $("edProf").value, ww: $("edWw").value, width: $("edWidth").value
    };
    if (kind === "flat" && extra.alt) lastAlt = extra.alt;
    const tags = Object.assign(keep, defaultTags(kind, extra));
    if (kind === "ramp") {
      tags.steepness = $("edSteep").value || "2";
      if (!tags.altitude_high) tags.altitude_high = extra.hi;
      if (!tags.altitude_low) tags.altitude_low = extra.lo;
    }
    if (kind === "waterway" && extra.width) tags.width = extra.width;
    if (kind === "dummy") {
      way.tags = {};
    } else {
      way.tags = tags;
    }
    enrich(way);
    markDirty();
    draw({ fit: false });
    selectWay(way.id, true);
    if (!(opts && opts.silent)) toast("Tags aplicadas em " + way.id);
  }

  function applyNode() {
    if (!selectedNode || !nodes[selectedNode]) return;
    pushUndo();
    const n = nodes[selectedNode];
    n.lat = parseFloat($("ndLat").value);
    n.lon = parseFloat($("ndLon").value);
    n.tags = n.tags || {};
    const abs = $("ndAbs").value.trim();
    const rel = $("ndRel").value.trim();
    if (abs) n.tags.alt_abs = abs; else delete n.tags.alt_abs;
    if (rel) n.tags.alt_rel = rel; else delete n.tags.alt_rel;
    markDirty();
    draw({ fit: false });
    if (selectedId) selectWay(selectedId, true);
  }

  function deleteSelected() {
    if (selKind === "node" && selectedNode && selectedId) {
      deleteVertex(selectedNode, getWay(selectedId));
      return;
    }
    if (selKind === "edge") {
      toast("Para apagar um vértice use o modo Nós. Del no modo Área remove o polígono.", "warn");
      return;
    }
    const way = getWay(selectedId);
    if (!way) return;
    if (!confirm("Remover way " + way.id + "?")) return;
    pushUndo();
    ways = ways.filter((w) => w.id !== way.id);
    pruneOrphans();
    selectedId = selectedId2 === way.id ? null : selectedId2;
    selectedId2 = null;
    selectedNode = null;
    markDirty();
    draw({ fit: false });
    $("inspWay").hidden = true;
    $("inspEmpty").hidden = false;
  }

  function deleteVertex(nodeId, way) {
    if (!way) return;
    const closed = isClosed(way.nd);
    let u = uniqueNd(way.nd).filter((id) => id !== nodeId);
    if (closed && u.length < 3) { toast("Polígono precisa de pelo menos 3 nós."); return; }
    if (!closed && u.length < 2) {
      pushUndo();
      ways = ways.filter((w) => w.id !== way.id);
      pruneOrphans();
      selectedId = null;
      selectedNode = null;
      markDirty();
      draw({ fit: false });
      return;
    }
    pushUndo();
    way.nd = closed ? u.concat([u[0]]) : u;
    selectedNode = null;
    pruneOrphans();
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
  }

  function reverseWay(way) {
    pushUndo();
    way.nd = way.nd.slice().reverse();
    enrich(way);
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
  }
  function rotateWay(way) {
    if (!isClosed(way.nd)) { toast("Girar só vale em anel fechado."); return; }
    pushUndo();
    const u = uniqueNd(way.nd);
    u.push(u.shift());
    way.nd = u.concat([u[0]]);
    enrich(way);
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast("Nós girados — high/low da rampa mudaram de aresta.");
  }
  function duplicateWay(way) {
    pushUndo();
    const offset = 8 / 111320;
    const mapIds = {};
    const nd = way.nd.map((id) => {
      if (mapIds[id]) return mapIds[id];
      const n = nodes[id];
      const nid = allocId();
      nodes[nid] = { lat: n.lat + offset, lon: n.lon, tags: Object.assign({}, n.tags || {}) };
      mapIds[id] = nid;
      return nid;
    });
    const w = enrich({ id: allocId(), nd: nd, tags: Object.assign({}, way.tags) });
    ways.push(w);
    markDirty();
    draw({ fit: false });
    selectWay(w.id);
  }
  function closeRing(way) {
    if (isClosed(way.nd)) { toast("Já está fechada."); return; }
    if (uniqueNd(way.nd).length < 3) { toast("Precisa de 3 nós."); return; }
    pushUndo();
    way.nd = way.nd.concat([way.nd[0]]);
    enrich(way);
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast("Anel fechado.", "ok");
  }
  function openRing(way) {
    if (!isClosed(way.nd)) { toast("Já está aberta."); return; }
    if (uniqueNd(way.nd).length < 2) return;
    pushUndo();
    way.nd = uniqueNd(way.nd);
    enrich(way);
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast("Anel aberto (linha).", "ok");
  }
  function toggleRing(way) {
    if (mode === "draw" && draft.length >= (LINE_KINDS[drawKind] ? 2 : 3)) {
      finishDraft(true);
      return;
    }
    if (!way) { toast("Selecione uma way, ou desenhe e pressione O para fechar o anel.", "warn"); return; }
    if (isClosed(way.nd)) openRing(way);
    else closeRing(way);
  }
  function densifyWay(way, spacing) {
    if (way.kind === "ramp") { toast("Não densifique rampas — OrthoForge exige 4 cantos."); return; }
    spacing = spacing || parseFloat($("edDens").value) || 8;
    pushUndo();
    const out = [way.nd[0]];
    for (let i = 1; i < way.nd.length; i++) {
      const a = nodes[way.nd[i - 1]], b = nodes[way.nd[i]];
      const d = metres([a.lat, a.lon], [b.lat, b.lon]);
      const cuts = Math.max(1, Math.ceil(d / spacing));
      for (let j = 1; j < cuts; j++) {
        const t = j / cuts;
        const id = allocId();
        nodes[id] = { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), tags: {} };
        out.push(id);
      }
      out.push(way.nd[i]);
    }
    way.nd = out;
    enrich(way);
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast("Densificado a cada " + spacing + " m.");
  }
  function simplifyWay(way, eps) {
    eps = eps || 1.5;
    if (way.kind === "ramp") { toast("Não simplifique rampas."); return; }
    const closed = isClosed(way.nd);
    const ids = uniqueNd(way.nd);
    if (ids.length < 3) return;
    const pts = ids.map((id) => [nodes[id].lat, nodes[id].lon]);
    const keep = douglasPeucker(pts, eps);
    keep[0] = keep[keep.length - 1] = true;
    const nid = ids.filter((_, i) => keep[i]);
    if (closed && nid.length < 3) { toast("Simplificação deixaria o anel inválido."); return; }
    pushUndo();
    way.nd = closed ? nid.concat([nid[0]]) : nid;
    enrich(way);
    pruneOrphans();
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
  }
  function douglasPeucker(pts, eps) {
    const keep = pts.map(() => false);
    function rec(a, b) {
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = distToSegM(pts[i], pts[a], pts[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx >= 0) { rec(a, idx); rec(idx, b); }
      else { keep[a] = keep[b] = true; }
    }
    rec(0, pts.length - 1);
    return keep;
  }
  function distToSegM(p, a, b) {
    const lat0 = a[0];
    const P = toXY(p[0], p[1], lat0), A = toXY(a[0], a[1], lat0), B = toXY(b[0], b[1], lat0);
    const vx = B.x - A.x, vy = B.y - A.y, l2 = vx * vx + vy * vy;
    let t = l2 ? ((P.x - A.x) * vx + (P.y - A.y) * vy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(P.x - (A.x + t * vx), P.y - (A.y + t * vy));
  }

  function segsOf(way) {
    const u = uniqueNd(way.nd);
    const wrap = isClosed(way.nd);
    const out = [];
    const n = u.length;
    const count = wrap ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = u[i], b = u[(i + 1) % n];
      out.push({ a: a, b: b });
    }
    return out;
  }
  function segDistM(s1, s2) {
    const a = ll(s1.a), b = ll(s1.b), c = ll(s2.a), d = ll(s2.b);
    if (!a || !b || !c || !d) return Infinity;
    return Math.min(
      distToSegM(a, c, d), distToSegM(b, c, d),
      distToSegM(c, a, b), distToSegM(d, a, b)
    );
  }
  function pairRampNodes(high, low) {
    const h0 = high.a, h1 = high.b, l0 = low.a, l1 = low.b;
    const d00 = metres(ll(h0), ll(l0)) + metres(ll(h1), ll(l1));
    const d01 = metres(ll(h0), ll(l1)) + metres(ll(h1), ll(l0));
    if (d00 <= d01) return { n0: h1, n1: l1, n2: l0, n3: h0 };
    return { n0: h1, n1: l0, n2: l1, n3: h0 };
  }
  function bridgeRamps() {
    const A = getWay(selectedId), B = getWay(selectedId2);
    if (!A || !B) { toast("Selecione duas flatten: clique + Shift+clique."); return; }
    if (!((A.kind === "flat" || A.kind === "abs") && (B.kind === "flat" || B.kind === "abs"))) {
      toast("Rampa entre só funciona com duas flatten.");
      return;
    }
    let best = { d: Infinity, sa: null, sb: null };
    segsOf(A).forEach((sa) => {
      segsOf(B).forEach((sb) => {
        const d = segDistM(sa, sb);
        if (d < best.d) best = { d: d, sa: sa, sb: sb };
      });
    });
    if (best.d > 80) { toast("Flatten longe demais (" + best.d.toFixed(0) + " m)."); return; }
    const aHigh = (A.alt ?? 0) >= (B.alt ?? 0);
    const highSeg = aHigh ? best.sa : best.sb;
    const lowSeg = aHigh ? best.sb : best.sa;
    const hi = aHigh ? A.alt : B.alt;
    const lo = aHigh ? B.alt : A.alt;
    const p = pairRampNodes(highSeg, lowSeg);
    createWay([p.n0, p.n1, p.n2, p.n3, p.n0], "ramp", { hi: hi, lo: lo });
    toast("Rampa " + hi + "→" + lo + " m entre " + A.id + " e " + B.id + ".");
  }

  function inferAlt(nodeIds) {
    let best = null;
    ways.forEach((w) => {
      if ((w.kind === "flat" || w.kind === "abs") && w.alt != null && nodeIds.every((id) => w.ids.has(id))) best = w.alt;
    });
    return best;
  }
  function autoRampAlts(way) {
    const u = uniqueNd(way.nd);
    if (u.length !== 4) return;
    const hi = inferAlt([u[3], u[0]]);
    const lo = inferAlt([u[1], u[2]]);
    if (hi != null) way.tags.altitude_high = String(hi);
    if (lo != null) way.tags.altitude_low = String(lo);
    if (hi != null && lo != null && hi < lo) {
      const t = way.tags.altitude_high;
      way.tags.altitude_high = way.tags.altitude_low;
      way.tags.altitude_low = t;
      const uu = uniqueNd(way.nd);
      uu.push(uu.shift());
      uu.push(uu.shift());
      way.nd = uu.concat([uu[0]]);
    }
  }

  function createWay(ids, kind, extra) {
    pushUndo();
    extra = extra || {};
    if (kind === "flat" && extra.alt) lastAlt = String(extra.alt);
    const w = enrich({ id: allocId(), nd: ids, tags: defaultTags(kind, extra) });
    if (kind === "ramp") autoRampAlts(w);
    enrich(w);
    ways.push(w);
    markDirty();
    draw({ fit: false });
    selectWay(w.id);
    if (kind === "ramp" && uniqueNd(w.nd).length !== 4) {
      toast("Rampa precisa de 4 cantos. Esta tem " + uniqueNd(w.nd).length + ".");
    } else if (kind === "ramp" && (w.tags.altitude_high === "" || w.tags.altitude_low === "")) {
      toast("Rampa criada. Preencha high/low no inspetor (ou use Rampa entre).");
    }
    return w;
  }

  function closestEdge(lat, lon, preferWay) {
    const origin = map.latLngToLayerPoint([lat, lon]);
    let best = null, bestD = 14;
    const list = preferWay ? [preferWay] : ways.filter(wayVisible);
    list.forEach((way) => {
      for (let i = 1; i < way.nd.length; i++) {
        const a = nodes[way.nd[i - 1]], b = nodes[way.nd[i]];
        if (!a || !b) continue;
        const pa = map.latLngToLayerPoint([a.lat, a.lon]);
        const pb = map.latLngToLayerPoint([b.lat, b.lon]);
        const vx = pb.x - pa.x, vy = pb.y - pa.y, l2 = vx * vx + vy * vy;
        let t = l2 ? ((origin.x - pa.x) * vx + (origin.y - pa.y) * vy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        if (t < 0.04 || t > 0.96) continue;
        const x = pa.x + t * vx, y = pa.y + t * vy;
        const d = Math.hypot(origin.x - x, origin.y - y);
        if (d < bestD) {
          bestD = d;
          best = {
            way: way, index: i, t: t,
            lat: a.lat + t * (b.lat - a.lat),
            lon: a.lon + t * (b.lon - a.lon)
          };
        }
      }
    });
    return best;
  }

  function insertAt(latlng, preferWay) {
    const hit = closestEdge(latlng.lat, latlng.lng, preferWay);
    if (!hit) { toast("Chegue mais perto de uma aresta."); return; }
    if (hit.way.kind === "ramp") {
      toast("Não dá para inserir vértice em rampa — o OrthoForge exige 4 cantos.");
      return;
    }
    pushUndo();
    const id = allocId();
    nodes[id] = { lat: hit.lat, lon: hit.lon, tags: {} };
    hit.way.nd.splice(hit.index, 0, id);
    enrich(hit.way);
    selectedId = hit.way.id;
    selectedNode = id;
    markDirty();
    draw({ fit: false });
    selectWay(hit.way.id, true);
    fillNodeForm(id);
  }

  function rect3(a, b, c) {
    const lat0 = (a.lat + b.lat + c.lat) / 3;
    const A = toXY(a.lat, a.lon, lat0), B = toXY(b.lat, b.lon, lat0), C = toXY(c.lat, c.lon, lat0);
    const vx = B.x - A.x, vy = B.y - A.y, len = Math.hypot(vx, vy) || 1;
    const nx = -vy / len, ny = vx / len;
    const dist = (C.x - A.x) * nx + (C.y - A.y) * ny;
    const D = fromXY(A.x + nx * dist, A.y + ny * dist, lat0);
    const E = fromXY(B.x + nx * dist, B.y + ny * dist, lat0);
    const e = { lat: E.lat, lon: E.lon, id: null };
    const d = { lat: D.lat, lon: D.lon, id: null };
    const se = snapNode(e.lat, e.lon);
    const sd = snapNode(d.lat, d.lon);
    if (se) { e.lat = se.lat; e.lon = se.lon; e.id = se.id; }
    if (sd) { d.lat = sd.lat; d.lon = sd.lon; d.id = sd.id; }
    return [
      { lat: a.lat, lon: a.lon, id: a.id },
      { lat: b.lat, lon: b.lon, id: b.id },
      e, d
    ];
  }

  function finishRect() {
    if (draft.length < 3) return;
    const corners = rect3(draft[0], draft[1], draft[2]);
    let ids = corners.map(ensureNode);
    ids.push(ids[0]);
    const kind = drawKind === "waterway" || drawKind === "dummy" ? "flat" : drawKind;
    if (kind === "ramp") ids = [ids[1], ids[2], ids[3], ids[0], ids[1]];
    createWay(ids, kind);
    draft = [];
    updateDraft();
    setMode("select");
  }

  function isPolyKind(k) { return !LINE_KINDS[k]; }

  function finishDraft(forceRing) {
    const line = LINE_KINDS[drawKind] && !forceRing;
    if (line && draft.length < 2) { toast("Linha precisa de 2 pontos."); return; }
    if (!line && draft.length < 3) { toast("Polígono precisa de 3 pontos."); return; }
    const ids = draft.map(ensureNode);
    if (!line && ids[0] !== ids[ids.length - 1]) ids.push(ids[0]);
    createWay(ids, drawKind);
    draft = [];
    updateDraft();
    setMode("select");
  }

  function addDraftPoint(ll) {
    if (mode === "rect") {
      const snap = snapOn ? (hoverSnap || snapNode(ll.lat, ll.lng)) : null;
      draft.push(snap ? { lat: snap.lat, lon: snap.lon, id: snap.id } : { lat: ll.lat, lon: ll.lng, id: null });
      updateDraft();
      if (draft.length >= 3) finishRect();
      return;
    }
    if (isPolyKind(drawKind) && draft.length >= 3) {
      const first = draft[0];
      const d = map.latLngToLayerPoint([first.lat, first.lon]).distanceTo(map.latLngToLayerPoint(ll));
      if (d < SNAP_PX) { finishDraft(); return; }
    }
    const snap = snapOn ? (hoverSnap || snapNode(ll.lat, ll.lng)) : null;
    draft.push(snap ? { lat: snap.lat, lon: snap.lon, id: snap.id } : { lat: ll.lat, lon: ll.lng, id: null });
    hoverSnap = null;
    updateDraft();
    showSnapTargets();
  }

  function updateDraft() {
    draftLayer.clearLayers();
    if (!draft.length) return;
    const latlngs = draft.map((p) => [p.lat, p.lon]);
    L.polyline(latlngs, { color: "#3ddc97", weight: 2, dashArray: "4 3" }).addTo(draftLayer);
    draft.forEach((p, i) => {
      L.circleMarker([p.lat, p.lon], {
        radius: i === 0 ? 8 : 6,
        color: p.id ? "#7ec8ff" : "#3ddc97",
        fillColor: p.id ? "#7ec8ff" : "#3ddc97",
        fillOpacity: 1, weight: 2
      }).addTo(draftLayer);
    });
  }

  function showSnapTargets() {
    snapLayer.clearLayers();
    if (!snapOn || (mode !== "draw" && mode !== "rect")) return;
    Object.keys(nodes).forEach((id) => {
      const n = nodes[id];
      const shared = nodeUseCount(id) > 1;
      L.circleMarker([n.lat, n.lon], {
        radius: shared ? 7 : 5,
        color: "#7ec8ff",
        fillColor: shared ? "#7ec8ff" : "#152544",
        fillOpacity: 0.9, weight: 2
      }).on("click", (ev) => {
        L.DomEvent.stop(ev);
        addDraftPoint(L.latLng(n.lat, n.lon));
      }).addTo(snapLayer);
    });
  }

  function showHoverSnap(hit) {
    draftLayer.eachLayer((l) => { if (l._hoverSnap) draftLayer.removeLayer(l); });
    if (!hit) return;
    const ring = L.circleMarker([hit.lat, hit.lon], { radius: 12, color: "#fff", fill: false, weight: 2 });
    ring._hoverSnap = true;
    ring.addTo(draftLayer);
  }

  function addMeasure(ll) {
    measurePts.push([ll.lat, ll.lng]);
    redrawMeasure();
  }
  function redrawMeasure() {
    measureLayer.clearLayers();
    if (!measurePts.length) return;
    L.polyline(measurePts, { color: "#ffe08a", weight: 2, dashArray: "5 4" }).addTo(measureLayer);
    let tot = 0;
    measurePts.forEach((p, i) => {
      L.circleMarker(p, { radius: 5, color: "#ffe08a", fillOpacity: 1 }).addTo(measureLayer);
      if (i) {
        const d = metres(measurePts[i - 1], p);
        tot += d;
        const mid = [(measurePts[i - 1][0] + p[0]) / 2, (measurePts[i - 1][1] + p[1]) / 2];
        L.marker(mid, {
          icon: L.divIcon({
            className: "",
            html: "<div style='background:#0c1222ee;color:#ffe08a;padding:1px 5px;border-radius:4px;font:11px monospace'>" +
              d.toFixed(1) + " m</div>",
            iconSize: [70, 16], iconAnchor: [35, 8]
          }),
          interactive: false
        }).addTo(measureLayer);
      }
    });
    if (measurePts.length > 1) {
      const last = measurePts[measurePts.length - 1], prev = measurePts[measurePts.length - 2];
      toast("Total " + tot.toFixed(1) + " m · último " + metres(prev, last).toFixed(1) + " m · az " + azimuth(prev, last).toFixed(1) + "°");
    } else toast("Clique o próximo ponto.");
  }

  function sampleElev(lat, lon) {
    return fetch("https://api.open-meteo.com/v1/elevation?latitude=" + lat + "&longitude=" + lon)
      .then((r) => r.json())
      .then((j) => (j.elevation && j.elevation.length ? j.elevation[0] : null));
  }

  function ownerWay(nodeId, prefer) {
    const owners = ways.filter((w) => w.ids && w.ids.has(nodeId) && wayVisible(w));
    if (prefer && owners.some((w) => w.id === prefer)) return getWay(prefer);
    const inJoin = owners.find((w) => joinOrder.indexOf(w.id) >= 0);
    if (inJoin) return inJoin;
    return owners.find((w) => w.kind === "flat" || w.kind === "abs") || owners[0] || null;
  }
  function renderJoinSlots() {
    const box = $("joinSlots");
    if (!box) return;
    box.innerHTML = "";
    ["Área A", "Área B"].forEach((label, i) => {
      const div = document.createElement("div");
      const wid = joinOrder[i];
      const ids = wid ? (joinNodes[wid] || []) : [];
      div.className = "join-slot" + (ids.length === 2 ? " ready" : "");
      if (!wid) div.textContent = label + " — clique 2 vértices ou a aresta";
      else {
        const w = getWay(wid);
        div.innerHTML = "<b>" + label + "</b> way " + wid +
          (w && w.alt != null ? " · " + w.alt + " m" : "") +
          "<br>vértices " + (ids.length ? ids.join(", ") : "—") +
          (ids.length === 2 ? " ✓" : " (" + ids.length + "/2)");
      }
      box.appendChild(div);
    });
  }
  function afterJoinPick() {
    selectedId = joinOrder[0] || null;
    selectedId2 = joinOrder[1] || null;
    renderJoinSlots();
    previewJoin();
    drawVerts();
    const a = joinOrder[0] && (joinNodes[joinOrder[0]] || []).length === 2;
    const b = joinOrder[1] && (joinNodes[joinOrder[1]] || []).length === 2;
    toast(a && b ? "Pronto. Enter ou Criar ligação." : (a ? "Agora a segunda área." : "Clique 2 vértices na primeira área."));
  }
  function previewJoin() {
    draftLayer.clearLayers();
    joinOrder.forEach((wid, i) => {
      const ids = joinNodes[wid] || [];
      if (ids.length === 2 && ll(ids[0]) && ll(ids[1])) {
        L.polyline([ll(ids[0]), ll(ids[1])], {
          color: i === 0 ? "#ff6b7a" : "#7ec8ff", weight: 5, interactive: false
        }).addTo(draftLayer);
      }
    });
    if (joinOrder.length < 2) return;
    const na = joinNodes[joinOrder[0]] || [];
    const nb = joinNodes[joinOrder[1]] || [];
    if (na.length !== 2 || nb.length !== 2) return;
    const A = getWay(joinOrder[0]), B = getWay(joinOrder[1]);
    if (!A || !B) return;
    const aHigh = (A.alt ?? 0) >= (B.alt ?? 0);
    const highN = aHigh ? na : nb;
    const lowN = aHigh ? nb : na;
    const p = pairRampNodes({ a: highN[0], b: highN[1] }, { a: lowN[0], b: lowN[1] });
    const ring = [p.n0, p.n1, p.n2, p.n3, p.n0].map(ll).filter(Boolean);
    L.polygon(ring, {
      color: "#ffb020", weight: 3, dashArray: "5 3",
      fillColor: "#ffb020", fillOpacity: 0.22, interactive: false
    }).addTo(draftLayer);
  }
  function pickJoinNode(nodeId, hintWay) {
    const way = ownerWay(nodeId, hintWay);
    if (!way) { toast("Nó sem área visível.", "warn"); return; }
    if (joinOrder.length >= 2 && joinOrder.indexOf(way.id) < 0) {
      toast("Já há duas áreas. Limpe para recomeçar.", "warn");
      return;
    }
    if (joinOrder.indexOf(way.id) < 0) joinOrder.push(way.id);
    const arr = (joinNodes[way.id] || []).slice();
    const ix = arr.indexOf(nodeId);
    if (ix >= 0) arr.splice(ix, 1);
    else if (arr.length >= 2) { arr.shift(); arr.push(nodeId); }
    else arr.push(nodeId);
    joinNodes[way.id] = arr;
    if (!arr.length) {
      delete joinNodes[way.id];
      joinOrder = joinOrder.filter((id) => id !== way.id);
    }
    afterJoinPick();
  }
  function pickJoinEdge(way, a, b) {
    if (!way || !a || !b || a === b) return;
    if (joinOrder.length >= 2 && joinOrder.indexOf(way.id) < 0) {
      toast("Já há duas áreas. Limpe para recomeçar.", "warn");
      return;
    }
    if (joinOrder.indexOf(way.id) < 0) joinOrder.push(way.id);
    joinNodes[way.id] = [a, b];
    afterJoinPick();
  }
  function joinClickOnWay(way, latlng) {
    const origin = map.latLngToLayerPoint(latlng);
    let bestV = null, bestD = SNAP_PX;
    uniqueNd(way.nd).forEach((id) => {
      const n = nodes[id];
      if (!n) return;
      const d = origin.distanceTo(map.latLngToLayerPoint([n.lat, n.lon]));
      if (d < bestD) { bestD = d; bestV = id; }
    });
    if (bestV) { pickJoinNode(bestV, way.id); return; }
    let bestSeg = null, bestM = 25;
    segsOf(way).forEach((s) => {
      const pa = ll(s.a), pb = ll(s.b);
      if (!pa || !pb) return;
      const d = distToSegM([latlng.lat, latlng.lng], pa, pb);
      if (d < bestM) { bestM = d; bestSeg = s; }
    });
    if (bestSeg) pickJoinEdge(way, bestSeg.a, bestSeg.b);
    else toast("Clique na borda que quer juntar.", "warn");
  }
  function clearJoin() {
    joinOrder = [];
    joinNodes = {};
    draftLayer.clearLayers();
    renderJoinSlots();
    drawVerts();
  }
  function joinUndoPick() {
    if (!joinOrder.length) return;
    const last = joinOrder[joinOrder.length - 1];
    const arr = (joinNodes[last] || []).slice();
    arr.pop();
    if (!arr.length) {
      delete joinNodes[last];
      joinOrder.pop();
    } else joinNodes[last] = arr;
    afterJoinPick();
  }
  function commitJoin() {
    const kind = ($("joinKind") && $("joinKind").value) || "ramp";
    if (joinOrder.length !== 2) { toast("Escolha vértices em duas áreas.", "warn"); return; }
    const A = getWay(joinOrder[0]), B = getWay(joinOrder[1]);
    const na = joinNodes[A.id] || [], nb = joinNodes[B.id] || [];
    if (kind === "waterway" || (kind === "dummy" && na.length === 1 && nb.length === 1)) {
      if (na.length < 1 || nb.length < 1) { toast("Um vértice em cada área.", "warn"); return; }
      createWay([na[0], nb[nb.length - 1]], kind === "waterway" ? "waterway" : "dummy");
      clearJoin();
      setMode("select");
      toast("Ligação criada.", "ok");
      return;
    }
    if (na.length !== 2 || nb.length !== 2) { toast("2 vértices em cada área.", "warn"); return; }
    const aHigh = (A.alt ?? 0) >= (B.alt ?? 0);
    const highW = aHigh ? A : B, lowW = aHigh ? B : A;
    const highN = joinNodes[highW.id], lowN = joinNodes[lowW.id];
    const p = pairRampNodes({ a: highN[0], b: highN[1] }, { a: lowN[0], b: lowN[1] });
    const ids = [p.n0, p.n1, p.n2, p.n3, p.n0];
    const extra = kind === "ramp"
      ? { hi: highW.alt, lo: lowW.alt }
      : { alt: highW.alt != null ? highW.alt : lastAlt };
    createWay(ids, kind, extra);
    clearJoin();
    setMode("select");
    toast("Ligação " + kind + " criada com nós compartilhados.", "ok");
  }

  function zoomSelection() {
    const w = getWay(selectedId);
    if (w && w._layer) map.fitBounds(w._layer.getBounds().pad(0.25));
    else if (overlay.getLayers().length) map.fitBounds(overlay.getBounds().pad(0.08));
  }
  function orthogonalize(way) {
    const ids = uniqueNd(way.nd);
    if (ids.length < 3) { toast("Poucos nós.", "warn"); return; }
    pushUndo();
    const lat0 = nodes[ids[0]].lat;
    const A = toXY(nodes[ids[0]].lat, nodes[ids[0]].lon, lat0);
    const B = toXY(nodes[ids[1]].lat, nodes[ids[1]].lon, lat0);
    const ang = Math.atan2(B.y - A.y, B.x - A.x);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    function rot(p) { const x = p.x - A.x, y = p.y - A.y; return { x: x * c - y * s, y: x * s + y * c }; }
    function unrot(p) {
      const cc = Math.cos(ang), ss = Math.sin(ang);
      return { x: A.x + p.x * cc - p.y * ss, y: A.y + p.x * ss + p.y * cc };
    }
    const local = ids.map((id) => rot(toXY(nodes[id].lat, nodes[id].lon, lat0)));
    for (let i = 1; i < local.length; i++) {
      const prev = local[i - 1];
      if (Math.abs(local[i].x - prev.x) > Math.abs(local[i].y - prev.y)) local[i].y = prev.y;
      else local[i].x = prev.x;
    }
    ids.forEach((id, i) => {
      const g = fromXY(unrot(local[i]).x, unrot(local[i]).y, lat0);
      nodes[id].lat = g.lat;
      nodes[id].lon = g.lon;
    });
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast("Ortogonalizado.", "ok");
  }
  function alignWay(way, axis) {
    const ids = uniqueNd(way.nd);
    if (!ids.length) return;
    pushUndo();
    const src = selectedNode && ids.indexOf(selectedNode) >= 0 ? selectedNode : ids[0];
    ids.forEach((id) => {
      if (axis === "h") nodes[id].lat = nodes[src].lat;
      else nodes[id].lon = nodes[src].lon;
    });
    markDirty();
    draw({ fit: false });
    selectWay(way.id, true);
    toast(axis === "h" ? "Alinhado na horizontal." : "Alinhado na vertical.", "ok");
  }
  function splitWayAtNode(way, nodeId) {
    splitOpenAtNodes(way, [nodeId]);
  }
  function ringArc(u, from, to) {
    const n = u.length;
    const path = [u[from]];
    let k = from;
    while (k !== to) {
      k = (k + 1) % n;
      path.push(u[k]);
    }
    return path;
  }
  function splitRingAtTwoNodes(way, a, b) {
    if (!way || !a || !b) return false;
    if (way.kind === "ramp") {
      toast("Não divida rampas — o OrthoForge exige 4 cantos.", "warn");
      return false;
    }
    const u = uniqueNd(way.nd);
    const i = u.indexOf(a), j = u.indexOf(b);
    if (i < 0 || j < 0) { toast("Os dois nós precisam ser da mesma way.", "warn"); return false; }
    if (i === j) { toast("Escolha dois nós diferentes.", "warn"); return false; }
    const n = u.length;
    const d = Math.min((j - i + n) % n, (i - j + n) % n);
    if (d === 1) {
      toast("Os nós não podem ser vizinhos — deixe pelo menos um vértice de cada lado do corte.", "warn");
      return false;
    }
    const path1 = ringArc(u, i, j);
    const path2 = ringArc(u, j, i);
    if (path1.length < 3 || path2.length < 3) {
      toast("Cada metade precisa de pelo menos 3 nós.", "warn");
      return false;
    }
    pushUndo();
    way.nd = path1.concat([path1[0]]);
    enrich(way);
    const w2 = enrich({
      id: allocId(),
      nd: path2.concat([path2[0]]),
      tags: Object.assign({}, way.tags)
    });
    ways.push(w2);
    selectedId2 = w2.id;
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast("Anel dividido em 2 áreas.", "ok");
    return true;
  }
  function splitOpenAtNodes(way, nodeIds) {
    if (!way) { toast("Selecione uma way.", "warn"); return false; }
    const u = uniqueNd(way.nd);
    const cuts = [...new Set(nodeIds || [])]
      .map((id) => u.indexOf(id))
      .filter((ix) => ix > 0 && ix < u.length - 1)
      .sort((a, b) => a - b);
    if (!cuts.length) { toast("Escolha um vértice interior na linha.", "warn"); return false; }
    pushUndo();
    const parts = [];
    let start = 0;
    cuts.forEach((ix) => {
      parts.push(u.slice(start, ix + 1));
      start = ix;
    });
    parts.push(u.slice(start));
    way.nd = parts[0];
    enrich(way);
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].length < 2) continue;
      ways.push(enrich({ id: allocId(), nd: parts[i], tags: Object.assign({}, way.tags) }));
    }
    markDirty();
    draw({ fit: false });
    selectWay(way.id);
    toast(parts.length === 2 ? "Way dividida." : "Way dividida em " + parts.length + " trechos.", "ok");
    return true;
  }
  function splitTargetWay() {
    if (selectedId) {
      const w = getWay(selectedId);
      if (w && splitPicks.every((id) => w.nd.indexOf(id) >= 0)) return w;
    }
    if (splitPicks.length) return ownerWay(splitPicks[0], selectedId);
    return getWay(selectedId);
  }
  function renderSplitSlots() {
    const box = $("splitSlots");
    if (!box) return;
    const way = splitTargetWay();
    const need = way && isClosed(way.nd) ? 2 : 1;
    const ready = splitPicks.length >= need && way;
    box.innerHTML = "";
    const div = document.createElement("div");
    div.className = "join-slot" + (ready ? " ready" : "");
    if (!way) div.textContent = "Clique na way e depois nos nós.";
    else {
      div.innerHTML = "<b>" + (way.closed ? "Anel" : "Linha") + "</b> way " + way.id +
        (way.alt != null ? " · " + way.alt + " m" : "") +
        "<br>nós " + (splitPicks.length ? splitPicks.join(" → ") : "—") +
        " (" + splitPicks.length + "/" + need + ")" + (ready ? " ✓" : "");
    }
    box.appendChild(div);
  }
  function afterSplitPick() {
    renderSplitSlots();
    previewSplit();
    drawVerts();
    const way = splitTargetWay();
    if (!way) { toast("Clique numa way, depois nos nós."); return; }
    if (isClosed(way.nd)) {
      toast(splitPicks.length >= 2 ? "Pronto. Enter ou Dividir agora." : "Clique o segundo nó do corte.");
    } else {
      toast(splitPicks.length >= 1 ? "Pronto. Enter divide a linha neste nó." : "Clique um nó interior.");
    }
  }
  function previewSplit() {
    draftLayer.clearLayers();
    const way = splitTargetWay();
    splitPicks.forEach((id, i) => {
      const p = ll(id);
      if (!p) return;
      L.circleMarker(p, {
        radius: 11, color: i === 0 ? "#ffb070" : "#ffe08a",
        fill: false, weight: 2, interactive: false
      }).addTo(draftLayer);
    });
    if (!way || splitPicks.length !== 2 || !isClosed(way.nd)) return;
    const u = uniqueNd(way.nd);
    const i = u.indexOf(splitPicks[0]), j = u.indexOf(splitPicks[1]);
    if (i < 0 || j < 0 || i === j) return;
    const p1 = ringArc(u, i, j);
    const p2 = ringArc(u, j, i);
    if (p1.length >= 3) {
      L.polygon(p1.concat([p1[0]]).map(ll).filter(Boolean), {
        color: "#ffb070", weight: 2, dashArray: "4 3",
        fillColor: "#ffb070", fillOpacity: 0.2, interactive: false
      }).addTo(draftLayer);
    }
    if (p2.length >= 3) {
      L.polygon(p2.concat([p2[0]]).map(ll).filter(Boolean), {
        color: "#7ec8ff", weight: 2, dashArray: "4 3",
        fillColor: "#7ec8ff", fillOpacity: 0.2, interactive: false
      }).addTo(draftLayer);
    }
    const a = ll(splitPicks[0]), b = ll(splitPicks[1]);
    if (a && b) {
      L.polyline([a, b], { color: "#fff", weight: 3, dashArray: "6 4", interactive: false }).addTo(draftLayer);
    }
  }
  function pickSplitNode(nodeId, hintWay) {
    const way = ownerWay(nodeId, hintWay || selectedId);
    if (!way) { toast("Nó sem way visível.", "warn"); return; }
    if (way.kind === "ramp") { toast("Não dá para dividir rampa (4 cantos).", "warn"); return; }
    if (selectedId !== way.id) {
      selectedId = way.id;
      splitPicks = [];
    }
    const ix = splitPicks.indexOf(nodeId);
    if (ix >= 0) splitPicks.splice(ix, 1);
    else if (splitPicks.length >= 2) { splitPicks.shift(); splitPicks.push(nodeId); }
    else splitPicks.push(nodeId);
    selectedNode = nodeId;
    afterSplitPick();
  }
  function splitClickOnWay(way, latlng) {
    if (selectedId !== way.id) {
      selectedId = way.id;
      splitPicks = [];
    }
    const origin = map.latLngToLayerPoint(latlng);
    let bestV = null, bestD = SNAP_PX + 6;
    uniqueNd(way.nd).forEach((id) => {
      const n = nodes[id];
      if (!n) return;
      const d = origin.distanceTo(map.latLngToLayerPoint([n.lat, n.lon]));
      if (d < bestD) { bestD = d; bestV = id; }
    });
    if (bestV) { pickSplitNode(bestV, way.id); return; }
    renderSplitSlots();
    previewSplit();
    drawVerts();
    toast(way.closed ? "Clique 2 nós no anel." : "Clique um nó interior da linha.");
  }
  function clearSplit() {
    splitPicks = [];
    draftLayer.clearLayers();
    renderSplitSlots();
    drawVerts();
  }
  function splitUndoPick() {
    splitPicks.pop();
    afterSplitPick();
  }
  function commitSplit() {
    const way = splitTargetWay() || getWay(selectedId);
    if (!way) { toast("Selecione uma way.", "warn"); return; }
    let ok = false;
    if (isClosed(way.nd)) {
      if (splitPicks.length !== 2) { toast("Clique 2 nós no anel para cortar.", "warn"); return; }
      ok = splitRingAtTwoNodes(way, splitPicks[0], splitPicks[1]);
    } else {
      const ids = splitPicks.length ? splitPicks : (selectedNode ? [selectedNode] : []);
      ok = splitOpenAtNodes(way, ids);
    }
    if (!ok) return;
    clearSplit();
    selKind = "node";
    setMode("select");
  }

  function walkDir(u, fromId, toId, dir) {
    const n = u.length;
    const i = u.indexOf(fromId);
    if (i < 0 || u.indexOf(toId) < 0) return null;
    const path = [fromId];
    let k = i;
    while (u[k] !== toId) {
      k = (k + dir + n) % n;
      path.push(u[k]);
      if (path.length > n + 1) return null;
    }
    return path;
  }
  function exclusiveArc(u, a, b, otherSet) {
    const fwd = walkDir(u, a, b, 1);
    const back = walkDir(u, a, b, -1);
    function exclusiveCount(path) {
      if (!path || path.length < 2) return -1;
      let n = 0;
      for (let i = 1; i < path.length - 1; i++) {
        if (!otherSet.has(path[i])) n++;
      }
      return n;
    }
    const sf = exclusiveCount(fwd), sb = exclusiveCount(back);
    if (sf < 0 && sb < 0) return null;
    if (sf > sb) return fwd;
    if (sb > sf) return back;
    return (fwd && back && fwd.length >= back.length) ? fwd : (fwd || back);
  }
  function sharedEndpoints(u, otherSet) {
    const n = u.length;
    const ends = [];
    for (let i = 0; i < n; i++) {
      if (!otherSet.has(u[i])) continue;
      const prevS = otherSet.has(u[(i - 1 + n) % n]);
      const nextS = otherSet.has(u[(i + 1) % n]);
      if (prevS !== nextS) ends.push(u[i]);
    }
    return [...new Set(ends)];
  }
  function buildMergedRing(wa, wb) {
    if (!wa || !wb) return { error: "Selecione duas áreas." };
    if (wa.id === wb.id) return { error: "Escolha duas áreas diferentes." };
    if (!isClosed(wa.nd) || !isClosed(wb.nd)) return { error: "As duas ways precisam ser anéis fechados." };
    if (wa.kind === "ramp" || wb.kind === "ramp") return { error: "Não una rampas (OrthoForge exige 4 cantos)." };
    const u1 = uniqueNd(wa.nd), u2 = uniqueNd(wb.nd);
    const set1 = new Set(u1), set2 = new Set(u2);
    const shared = u1.filter((id) => set2.has(id));
    if (shared.length < 2) return { error: "As áreas precisam compartilhar pelo menos 2 nós (aresta comum)." };
    let a, b;
    const ends1 = sharedEndpoints(u1, set2);
    if (ends1.length === 2) { a = ends1[0]; b = ends1[1]; }
    else if (shared.length === 2) { a = shared[0]; b = shared[1]; }
    else return { error: shared.length + " nós comuns — preciso de uma aresta compartilhada (2 pontas)." };
    const outer1 = exclusiveArc(u1, a, b, set2);
    const outer2 = exclusiveArc(u2, b, a, set1);
    if (!outer1 || !outer2 || outer1.length < 3 || outer2.length < 3) {
      return { error: "Não achei o contorno externo. Os 2 nós precisam estar na aresta comum." };
    }
    const ring = outer1.concat(outer2.slice(1));
    const out = [ring[0]];
    for (let i = 1; i < ring.length; i++) {
      if (ring[i] !== out[out.length - 1]) out.push(ring[i]);
    }
    if (out[0] !== out[out.length - 1]) out.push(out[0]);
    if (uniqueNd(out).length < 3) return { error: "O anel unido teria menos de 3 nós." };
    return { nd: out, shared: shared.length, a: a, b: b };
  }
  function updateMergeBanner() {
    const el = $("mergeBanner");
    if (!el) return;
    const a = getWay(selectedId), b = getWay(selectedId2);
    if (!a || !b || a.id === b.id) { el.hidden = true; return; }
    const built = buildMergedRing(a, b);
    el.hidden = false;
    if (built.error) {
      el.className = "join-slot";
      el.textContent = "2ª área " + b.id + " — " + built.error;
    } else {
      el.className = "join-slot ready";
      el.innerHTML = "<b>Prontas para Unir</b> " + a.id + " + " + b.id +
        "<br>" + built.shared + " nós comuns · costura " + built.a + " — " + built.b;
    }
  }
  function previewMerge() {
    draftLayer.clearLayers();
    const a = getWay(selectedId), b = getWay(selectedId2);
    if (!a || !b) return;
    const built = buildMergedRing(a, b);
    if (built.error || !built.nd) return;
    const latlngs = built.nd.map(ll).filter(Boolean);
    L.polygon(latlngs, {
      color: "#3ddc97", weight: 3, dashArray: "5 3",
      fillColor: "#3ddc97", fillOpacity: 0.22, interactive: false
    }).addTo(draftLayer);
  }
  function pickMergeWay(way) {
    if (!selectedId || selectedId === way.id) {
      selectedId = way.id;
      selectedId2 = null;
      draw({ fit: false });
      toast("Agora clique a segunda área (2 nós em comum).");
      return;
    }
    selectedId2 = way.id;
    const built = buildMergedRing(getWay(selectedId), way);
    draw({ fit: false });
    previewMerge();
    updateMergeBanner();
    if (built.error) toast(built.error, "warn");
    else toast("Pronto. Enter ou Unir funde numa só área.", "ok");
  }
  function requestMerge() {
    const a = getWay(selectedId), b = getWay(selectedId2);
    if (a && b && a.id !== b.id) {
      mergeWays(a, b);
      return;
    }
    selKind = "area";
    setMode("merge");
  }
  function mergeWays(wa, wb) {
    const built = buildMergedRing(wa, wb);
    if (built.error) { toast(built.error, "warn"); return false; }
    let extra = "";
    if (wa.alt != null && wb.alt != null && wa.alt !== wb.alt) {
      extra = " Tags da primeira (" + wa.alt + " m) mantidas.";
    }
    pushUndo();
    wa.nd = built.nd;
    enrich(wa);
    ways = ways.filter((w) => w.id !== wb.id);
    pruneOrphans();
    selectedId = wa.id;
    selectedId2 = null;
    selectedNode = null;
    selectedEdge = null;
    markDirty();
    setMode("select");
    selKind = "area";
    syncSelButtons();
    draw({ fit: false });
    selectWay(wa.id);
    toast("Áreas unidas em " + wa.id + "." + extra, "ok");
    return true;
  }
  function nearestSegOnWay(way, latlng) {
    const origin = map.latLngToLayerPoint(latlng);
    let best = null, bestD = Infinity;
    segsOf(way).forEach((s) => {
      const pa = ll(s.a), pb = ll(s.b);
      if (!pa || !pb) return;
      const d = distPointToSegPx(origin, map.latLngToLayerPoint(pa), map.latLngToLayerPoint(pb));
      if (d < bestD) { bestD = d; best = s; }
    });
    return best ? { a: best.a, b: best.b, distPx: bestD } : null;
  }
  function applyEdgeSelection(way, seg, opts) {
    opts = opts || {};
    selectedEdge = { wayId: way.id, a: seg.a, b: seg.b };
    selectedId = way.id;
    selectedId2 = null;
    selectedNode = null;
    if (opts.fill !== false) fillForm(way);
    $("inspEmpty").hidden = true;
    $("inspWay").hidden = false;
    if (opts.redraw) {
      draw({ fit: false });
    } else {
      if (way._layer && way._layer.setStyle) way._layer.setStyle({ weight: 3.5, color: "#fff" });
      drawSelectedEdge();
    }
    if (opts.toast !== false) {
      const len = metres(ll(seg.a), ll(seg.b));
      toast("Aresta " + seg.a + " — " + seg.b + " · " + len.toFixed(1) + " m. Arraste para mover.");
    }
  }
  function pickEdgeOnWay(way, latlng) {
    const hit = nearestSegOnWay(way, latlng);
    if (!hit) { toast("Way sem arestas.", "warn"); return; }
    applyEdgeSelection(way, hit, { redraw: true });
  }
  function beginEdgeMove(way, latlng, originalEvent) {
    const hit = nearestSegOnWay(way, latlng);
    if (!hit) { toast("Way sem arestas.", "warn"); return; }
    selectedEdge = { wayId: way.id, a: hit.a, b: hit.b };
    selectedId = way.id;
    selectedId2 = null;
    selectedNode = null;
    $("inspEmpty").hidden = true;
    $("inspWay").hidden = false;
    if (way._layer && way._layer.setStyle) way._layer.setStyle({ weight: 3.5, color: "#fff" });
    drawSelectedEdge();
    startEdgeDrag(latlng, false, originalEvent);
  }
  function distPointToSegPx(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
  }
  function edgeMidLatLng() {
    if (!selectedEdge) return null;
    const a = nodes[selectedEdge.a], b = nodes[selectedEdge.b];
    if (!a || !b) return null;
    return L.latLng((a.lat + b.lat) / 2, (a.lon + b.lon) / 2);
  }
  function refreshEdgeGraphic() {
    if (!selectedEdge || !edgeUi) return;
    const pa = ll(selectedEdge.a), pb = ll(selectedEdge.b);
    if (!pa || !pb) return;
    if (edgeUi.line) edgeUi.line.setLatLngs([pa, pb]);
    if (edgeUi.hit) edgeUi.hit.setLatLngs([pa, pb]);
    const mid = edgeMidLatLng();
    if (edgeUi.mid && mid) edgeUi.mid.setLatLng(mid);
  }
  function startEdgeDrag(latlng, fromMid, originalEvent) {
    if (!selectedEdge || !nodes[selectedEdge.a] || !nodes[selectedEdge.b]) return;
    map.dragging.disable();
    map.getContainer().classList.add("edge-dragging");
    const a = selectedEdge.a, b = selectedEdge.b;
    edgeDrag = {
      start: { lat: latlng.lat, lng: latlng.lng },
      origA: { lat: nodes[a].lat, lon: nodes[a].lon },
      origB: { lat: nodes[b].lat, lon: nodes[b].lon },
      a: a, b: b, fromMid: !!fromMid, undid: false
    };
    edgeJustDragged = false;
    if (originalEvent && originalEvent.pointerId != null) {
      try { map.getContainer().setPointerCapture(originalEvent.pointerId); } catch (err) {}
    }
  }
  function updateEdgeDrag(latlng) {
    if (!edgeDrag) return;
    const p0 = map.latLngToLayerPoint(L.latLng(edgeDrag.start.lat, edgeDrag.start.lng));
    const p1 = map.latLngToLayerPoint(latlng);
    if (!edgeDrag.undid && Math.hypot(p1.x - p0.x, p1.y - p0.y) < 3) return;
    const dlat = latlng.lat - edgeDrag.start.lat;
    const dlon = latlng.lng - edgeDrag.start.lng;
    if (!edgeDrag.undid) {
      pushUndo();
      edgeDrag.undid = true;
    }
    edgeJustDragged = true;
    nodes[edgeDrag.a].lat = edgeDrag.origA.lat + dlat;
    nodes[edgeDrag.a].lon = edgeDrag.origA.lon + dlon;
    nodes[edgeDrag.b].lat = edgeDrag.origB.lat + dlat;
    nodes[edgeDrag.b].lon = edgeDrag.origB.lon + dlon;
    ways.forEach((w) => {
      if (!w._layer || !w._layer.setLatLngs) return;
      if (w.nd.indexOf(edgeDrag.a) < 0 && w.nd.indexOf(edgeDrag.b) < 0) return;
      w.latlngs = w.nd.map(ll).filter(Boolean);
      w._layer.setLatLngs(w.latlngs);
    });
    refreshEdgeGraphic();
  }
  function endEdgeDrag() {
    if (!edgeDrag) return;
    const moved = edgeDrag.undid && edgeJustDragged;
    const way = getWay(selectedEdge && selectedEdge.wayId) || getWay(selectedId);
    edgeDrag = null;
    map.dragging.enable();
    map.getContainer().classList.remove("edge-dragging");
    if (moved) markDirty();
    draw({ fit: false });
    if (way) fillForm(way);
    if (selectedEdge) {
      const len = metres(ll(selectedEdge.a), ll(selectedEdge.b));
      toast(moved
        ? "Aresta movida · " + len.toFixed(1) + " m."
        : "Aresta " + selectedEdge.a + " — " + selectedEdge.b + " · " + len.toFixed(1) + " m. Arraste para mover.",
        moved ? "ok" : "");
    }
  }
  function clearEdgeUi() {
    if (!edgeUi) return;
    if (edgeUi.line) map.removeLayer(edgeUi.line);
    if (edgeUi.hit) map.removeLayer(edgeUi.hit);
    if (edgeUi.mid) {
      if (verts.hasLayer && verts.hasLayer(edgeUi.mid)) verts.removeLayer(edgeUi.mid);
      else map.removeLayer(edgeUi.mid);
    }
    edgeUi = null;
  }
  function drawSelectedEdge() {
    clearEdgeUi();
    if (!selectedEdge || selKind !== "edge") return;
    const pa = ll(selectedEdge.a), pb = ll(selectedEdge.b);
    if (!pa || !pb) return;
    const hit = L.polyline([pa, pb], {
      pane: "edgePane",
      color: "#fff", weight: 28, opacity: 0.001, interactive: true,
      bubblingMouseEvents: false, className: "edge-drag-hit"
    });
    const line = L.polyline([pa, pb], {
      pane: "edgePane",
      color: "#fff", weight: 8, opacity: 0.95, interactive: false,
      bubblingMouseEvents: false, className: "edge-drag-line"
    });
    function downOnEdge(ev) {
      if (ev.originalEvent && ev.originalEvent.button !== 0) return;
      if (spaceDown) return;
      L.DomEvent.stop(ev);
      if (ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
      startEdgeDrag(ev.latlng, false, ev.originalEvent);
    }
    hit.on("mousedown", downOnEdge);
    hit.addTo(map);
    line.addTo(map);
    const mid = edgeMidLatLng();
    const handle = L.marker(mid, {
      pane: "vertsPane",
      draggable: false,
      autoPan: false,
      keyboard: false,
      zIndexOffset: 4000,
      icon: L.divIcon({
        className: "vert-handle edge-handle",
        html: "<div class='edge-mid'></div>",
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      })
    });
    handle.on("mousedown", (ev) => {
      if (ev.originalEvent && ev.originalEvent.button !== 0) return;
      if (spaceDown) return;
      L.DomEvent.stop(ev);
      if (ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
      startEdgeDrag(ev.latlng || handle.getLatLng(), true, ev.originalEvent);
    });
    handle.addTo(verts);
    edgeUi = { line: line, hit: hit, mid: handle };
  }

  function setMode(m, kind) {
    mode = m;
    if (kind) drawKind = kind;
    document.querySelectorAll("button[data-mode]").forEach((b) => {
      const sameMode = b.getAttribute("data-mode") === m;
      const bk = b.getAttribute("data-kind");
      b.classList.toggle("active", sameMode && (!bk || bk === drawKind));
    });
    const drawing = m === "draw" || m === "rect";
    const picking = m === "insert" || m === "measure" || m === "elev" || m === "join" || m === "split" || m === "merge";
    map.getContainer().classList.toggle("drawing", drawing || picking);
    map.doubleClickZoom[drawing || m === "measure" || m === "join" || m === "split" || m === "merge" ? "disable" : "enable"]();
    draft = [];
    updateDraft();
    if (m !== "measure") { measurePts = []; measureLayer.clearLayers(); }
    if (m !== "join") clearJoin();
    if (m !== "split") clearSplit();
    else if (selectedNode && !splitPicks.length) splitPicks = [selectedNode];
    if (m === "join") selKind = "edge";
    else if (m === "insert") selKind = "edge";
    else if (m === "split") selKind = "node";
    else if (m === "merge") selKind = "area";
    if (drawing) {
      stopLive();
      showSnapTargets();
    } else snapLayer.clearLayers();
    if ($("inspJoin")) $("inspJoin").hidden = m !== "join";
    if ($("inspSplit")) $("inspSplit").hidden = m !== "split";
    if (m === "join") {
      $("inspWay").hidden = true;
      $("inspEmpty").hidden = true;
      $("inspNode").hidden = true;
      renderJoinSlots();
      draw({ fit: false });
    } else if (m === "split") {
      $("inspWay").hidden = true;
      $("inspEmpty").hidden = true;
      $("inspNode").hidden = true;
      renderSplitSlots();
      previewSplit();
      draw({ fit: false });
    } else if (m === "merge") {
      $("inspWay").hidden = false;
      $("inspEmpty").hidden = true;
      $("inspNode").hidden = true;
      if (selectedId && getWay(selectedId)) fillForm(getWay(selectedId));
      updateMergeBanner();
      previewMerge();
      draw({ fit: false });
    } else if (selectedId && getWay(selectedId)) {
      $("inspEmpty").hidden = true;
      $("inspWay").hidden = false;
      fillForm(getWay(selectedId));
    } else {
      $("inspEmpty").hidden = false;
      $("inspWay").hidden = true;
    }
    syncSelButtons();
    toast(m === "select" ? (SEL_HINT[selKind] || MODE_HINT.select) : (MODE_HINT[m] || ""));
    setModeLabel();
  }

  function cancelDraw() {
    draft = [];
    updateDraft();
    measurePts = [];
    measureLayer.clearLayers();
    clearJoin();
    clearSplit();
    setMode("select");
  }

  function markDirty(fromUndo) {
    dirty = true;
    stopLive();
    if (!fromUndo) $("fileLabel").textContent = fileBase() + " *";
  }

  function serializeOsm() {
    const nodeIds = Object.keys(nodes).sort((a, b) => Number(a) - Number(b));
    let xml = "<?xml version='1.0' encoding='UTF-8'?>\n<osm version='0.6' generator='OrthoForgePatchEditor'>\n";
    nodeIds.forEach((id) => {
      const n = nodes[id];
      const tags = n.tags && Object.keys(n.tags).length;
      xml += "  <node id='" + esc(id) + "' action='modify' visible='true' lat='" +
        fmtCoord(n.lat) + "' lon='" + fmtCoord(n.lon) + "'" + (tags ? ">\n" : " />\n");
      if (tags) {
        Object.keys(n.tags).forEach((k) => {
          xml += "    <tag k='" + esc(k) + "' v='" + esc(n.tags[k]) + "' />\n";
        });
        xml += "  </node>\n";
      }
    });
    ways.forEach((w) => {
      xml += "  <way id='" + esc(w.id) + "' action='modify' visible='true'>\n";
      w.nd.forEach((id) => { xml += "    <nd ref='" + esc(id) + "' />\n"; });
      Object.keys(w.tags).forEach((k) => {
        xml += "    <tag k='" + esc(k) + "' v='" + esc(w.tags[k]) + "' />\n";
      });
      xml += "  </way>\n";
    });
    rels.forEach((r) => {
      xml += "  <relation id='" + esc(r.id) + "' action='modify' visible='true'>\n";
      r.members.forEach((m) => {
        xml += "    <member type='" + esc(m.type) + "' ref='" + esc(m.ref) + "' role='" + esc(m.role || "") + "' />\n";
      });
      Object.keys(r.tags || {}).forEach((k) => {
        xml += "    <tag k='" + esc(k) + "' v='" + esc(r.tags[k]) + "' />\n";
      });
      xml += "  </relation>\n";
    });
    xml += "</osm>\n";
    return xml;
  }

  function parseOsm(xmlText, opts) {
    opts = opts || {};
    if (xmlText === lastXml && opts.silent) return;
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    if (xml.querySelector("parsererror")) {
      if (!opts.silent) toast("XML inválido (arquivo ainda salvando?).");
      return;
    }
    lastXml = xmlText;
    nodes = {};
    xml.querySelectorAll("node").forEach((n) => {
      const tags = {};
      n.querySelectorAll("tag").forEach((t) => { tags[t.getAttribute("k")] = t.getAttribute("v"); });
      nodes[n.getAttribute("id")] = {
        lat: parseFloat(n.getAttribute("lat")),
        lon: parseFloat(n.getAttribute("lon")),
        tags: tags
      };
    });
    ways = [];
    xml.querySelectorAll("way").forEach((w) => {
      const tags = {};
      w.querySelectorAll("tag").forEach((t) => { tags[t.getAttribute("k")] = t.getAttribute("v"); });
      const nd = [];
      w.querySelectorAll("nd").forEach((el) => nd.push(el.getAttribute("ref")));
      if (nd.length < 2) return;
      ways.push(enrich({ id: w.getAttribute("id"), nd: nd, tags: tags }));
    });
    rels = [];
    xml.querySelectorAll("relation").forEach((r) => {
      const tags = {};
      r.querySelectorAll("tag").forEach((t) => { tags[t.getAttribute("k")] = t.getAttribute("v"); });
      rels.push({
        id: r.getAttribute("id"),
        members: [...r.querySelectorAll("member")].map((m) => ({
          type: m.getAttribute("type"), ref: m.getAttribute("ref"), role: m.getAttribute("role") || ""
        })),
        tags: tags
      });
    });
    refreshNextId();
    dirty = false;
    draw({ fit: opts.fit !== false && !didFit, silent: !!opts.silent });
  }

  function fileBase() {
    return String(OSM_FILE || "").replace(/^.*[\\/]/, "") || OSM_FILE;
  }
  function applyOpenedFile(info) {
    if (!info) return;
    if (typeof info === "string") {
      OSM_FILE = info;
      OSM_ABS = "";
      return;
    }
    OSM_FILE = info.path || info.name || OSM_FILE;
    OSM_ABS = info.abs || "";
    if (info.tile && info.tile.lat != null) TILE = info.tile;
  }
  function saveOsm(asDownload) {
    if (selectedId && $("inspWay") && !$("inspWay").hidden) applyTags({ silent: true });
    const xml = serializeOsm();
    if (asDownload) {
      const blob = new Blob([xml], { type: "application/xml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileBase();
      a.click();
      toast("Download de " + fileBase());
      return;
    }
    if (diskHandle && diskHandle.createWritable) {
      diskHandle.createWritable().then((w) => w.write(xml).then(() => w.close())).then(() => {
        dirty = false;
        lastXml = xml;
        toast("Gravado " + (diskHandle.name || fileBase()));
        draw({ fit: false });
      }).catch(() => {
        saveOsm(true);
        toast("Não deu para gravar neste arquivo — baixei o OSM.", "warn");
      });
      return;
    }
    fetch("/save?path=" + encodeURIComponent(OSM_FILE), {
      method: "POST", headers: { "Content-Type": "application/xml" }, body: xml
    }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json().catch(() => ({}));
    }).then((info) => {
      dirty = false;
      lastXml = xml;
      if (info && info.abs) OSM_ABS = info.abs;
      if (info && info.file) OSM_FILE = info.file;
      toast("Gravado " + fileBase() + " (backup .bak).");
      draw({ fit: false });
    }).catch(() => {
      saveOsm(true);
      toast("Servidor de save offline — baixei o OSM.", "warn");
    });
  }

  function load(silent) {
    if (dirty && silent) return Promise.resolve();
    const url = "/api/osm?path=" + encodeURIComponent(OSM_FILE) + "&t=" + Date.now();
    return fetch(url, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then((txt) => parseOsm(txt, { silent: !!silent, fit: !silent && !didFit }))
      .catch((err) => {
        if (silent) return;
        stopLive();
        $("statLine").innerHTML = "Rode <code>abrir-editor.bat</code> (ou <code>python servir-editor.py</code>) e abra <code>http://127.0.0.1:8766/editor.html</code>.";
        console.warn(err);
      });
  }

  function startLive() {
    if (dirty) return;
    liveOn = true;
    $("btnLive").classList.add("active");
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => load(true), 2000);
  }
  function stopLive() {
    liveOn = false;
    $("btnLive").classList.remove("active");
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function loadRef() {
    if (refOn) {
      map.removeLayer(refLayer);
      refLayer.clearLayers();
      refOn = false;
      $("btnRef").classList.remove("active");
      return;
    }
    const b = map.getBounds();
    const q = "[out:json][timeout:25];(" +
      'way["aeroway"~"runway|taxiway|apron|helipad"](' + b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast() + ");" +
      'way["natural"="water"](' + b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast() + ");" +
      'way["waterway"](' + b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast() + ");" +
      ");out geom;";
    toast("Baixando OSM de referência…");
    fetch("https://overpass.kumi.systems/api/interpreter", { method: "POST", body: q })
      .then((r) => r.json())
      .then((data) => {
        refLayer.clearLayers();
        (data.elements || []).forEach((el) => {
          if (!el.geometry) return;
          const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
          const tags = el.tags || {};
          const col = tags.aeroway ? "#fff" : "#5ec8ff";
          L.polyline(latlngs, { color: col, weight: tags.aeroway === "runway" ? 3 : 1.5, opacity: 0.7, interactive: false }).addTo(refLayer);
        });
        refLayer.addTo(map);
        refOn = true;
        $("btnRef").classList.add("active");
        toast((data.elements || []).length + " ways de referência (não entram no patch).");
      })
      .catch(() => toast("Overpass falhou. Tente de novo ou verifique a rede."));
  }

  function nudge(dlat, dlon) {
    if (!selectedNode && !selectedId && !selectedEdge) return;
    let ids = [];
    if (mode === "select" && selKind === "area" && selectedId) {
      ids = uniqueNd(getWay(selectedId).nd).slice();
      if (selectedId2 && getWay(selectedId2)) ids = ids.concat(uniqueNd(getWay(selectedId2).nd));
    } else if (selKind === "edge" && selectedEdge) {
      ids = [selectedEdge.a, selectedEdge.b];
    } else if (selectedNode) {
      ids = [selectedNode];
    } else if (selectedId) {
      ids = uniqueNd(getWay(selectedId).nd);
    }
    if (!ids.length) return;
    pushUndo();
    const seen = new Set();
    ids.forEach((id) => {
      if (seen.has(id) || !nodes[id]) return;
      seen.add(id);
      nodes[id].lat += dlat;
      nodes[id].lon += dlon;
    });
    markDirty();
    draw({ fit: false });
    if (selectedId) selectWay(selectedId, true);
  }

  function setBase(layer, btn) {
    [sat, osm, topo].forEach((l) => map.removeLayer(l));
    layer.addTo(map);
    overlay.bringToFront();
    ["btnSat", "btnOsm", "btnTopo"].forEach((id) => $(id).classList.remove("active"));
    btn.classList.add("active");
  }

  function makeTileRect() {
    if (tileRect) map.removeLayer(tileRect);
    tileRect = L.rectangle(
      [[TILE.lat, TILE.lon], [TILE.lat + 1, TILE.lon + 1]],
      { color: "#3ddc97", weight: 1, dashArray: "6 4", fill: false, interactive: false }
    );
  }

  map.on("mousemove", (e) => {
    if (edgeDrag) {
      updateEdgeDrag(e.latlng);
      return;
    }
    const drawing = mode === "draw" || mode === "rect";
    const hit = (snapOn && drawing) ? snapNode(e.latlng.lat, e.latlng.lng) : null;
    hoverSnap = hit;
    let extra = hit ? "SNAP " + hit.id + " · " : "";
    if (mode === "insert") {
      const edge = closestEdge(e.latlng.lat, e.latlng.lng, getWay(selectedId));
      if (edge) {
        extra = "+vértice · ";
        if (!insertPreview) {
          insertPreview = L.circleMarker([edge.lat, edge.lon], { radius: 6, color: "#fff", fillColor: "#3ddc97", fillOpacity: 1, weight: 2, interactive: false });
        } else insertPreview.setLatLng([edge.lat, edge.lon]);
        if (!draftLayer.hasLayer(insertPreview)) insertPreview.addTo(draftLayer);
      } else if (insertPreview && draftLayer.hasLayer(insertPreview)) {
        draftLayer.removeLayer(insertPreview);
      }
    }
    $("coords").textContent = extra + e.latlng.lat.toFixed(6) + ", " + e.latlng.lng.toFixed(6);
    if (mode === "rect" && draft.length === 2) {
      updateDraft();
      const corners = rect3(draft[0], draft[1], { lat: e.latlng.lat, lon: e.latlng.lng, id: null });
      const latlngs = corners.map((p) => [p.lat, p.lon]);
      if (!rectPreview) {
        rectPreview = L.polygon(latlngs, {
          color: "#3ddc97", weight: 2, dashArray: "4 3", fillColor: "#3ddc97", fillOpacity: 0.12, interactive: false
        });
      } else rectPreview.setLatLngs(latlngs);
      if (!draftLayer.hasLayer(rectPreview)) rectPreview.addTo(draftLayer);
    } else if (drawing) {
      showHoverSnap(hit);
    }
  });

  function finishEdgePointer() {
    if (edgeDrag) endEdgeDrag();
  }
  map.on("mouseup", finishEdgePointer);
  function onEdgePointerMove(e) {
    if (!edgeDrag) return;
    if (typeof e.buttons === "number" && e.buttons === 0) return;
    updateEdgeDrag(map.mouseEventToLatLng(e));
  }
  map.getContainer().addEventListener("pointermove", onEdgePointerMove, true);
  document.addEventListener("pointermove", onEdgePointerMove, true);
  map.getContainer().addEventListener("pointerup", finishEdgePointer, true);
  document.addEventListener("pointerup", finishEdgePointer, true);
  document.addEventListener("pointercancel", finishEdgePointer, true);

  map.on("click", (e) => {
    if (edgeJustDragged) { edgeJustDragged = false; return; }
    if (e.originalEvent && e.originalEvent.button === 1) return;
    if (mode === "draw" || mode === "rect") {
      L.DomEvent.stopPropagation(e);
      addDraftPoint(e.latlng);
      return;
    }
    if (mode === "insert") { insertAt(e.latlng, getWay(selectedId)); return; }
    if (mode === "measure") { addMeasure(e.latlng); return; }
    if (mode === "join") {
      const hitWay = ways.find((w) => wayVisible(w) && w._layer && w._layer.getBounds && w._layer.getBounds().pad(0.02).contains(e.latlng));
      if (hitWay) joinClickOnWay(hitWay, e.latlng);
      return;
    }
    if (mode === "split") {
      const hitWay = ways.find((w) => wayVisible(w) && w._layer && w._layer.getBounds && w._layer.getBounds().pad(0.02).contains(e.latlng));
      if (hitWay) splitClickOnWay(hitWay, e.latlng);
      return;
    }
    if (mode === "elev") {
      toast("Consultando DEM…");
      sampleElev(e.latlng.lat, e.latlng.lng).then((h) => {
        if (h == null) { toast("DEM sem valor."); return; }
        toast(h.toFixed(1) + " m  ·  " + e.latlng.lat.toFixed(6) + ", " + e.latlng.lng.toFixed(6));
        const way = getWay(selectedId);
        if (way && (way.kind === "flat" || way.kind === "abs")) {
          $("edAlt").value = h.toFixed(1);
        }
      }).catch(() => toast("Falha no DEM."));
      return;
    }
    navigator.clipboard.writeText(e.latlng.lat.toFixed(6) + ", " + e.latlng.lng.toFixed(6)).catch(() => {});
  });

  map.on("dblclick", (e) => {
    if (mode === "draw") {
      L.DomEvent.stop(e);
      finishDraft();
    }
  });

  document.addEventListener("keydown", (e) => {
    const inField = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA");
    if (e.key === "Escape") { cancelDraw(); return; }
    if (e.code === "Space") {
      if (!inField) { spaceDown = true; e.preventDefault(); }
    }
    if (e.key === "Enter" && inField && e.target.closest && e.target.closest("#inspWay")) {
      e.preventDefault();
      applyTags();
      saveOsm(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      applyTags();
      saveOsm(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveOsm(false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      const w = getWay(selectedId);
      if (w) duplicateWay(w);
      return;
    }
    if (inField) return;
    if (e.key === "Enter" && mode === "draw") { e.preventDefault(); finishDraft(); return; }
    if (e.key === "Enter" && mode === "join") { e.preventDefault(); commitJoin(); return; }
    if (e.key === "Enter" && mode === "split") { e.preventDefault(); commitSplit(); return; }
    if (e.key === "Enter" && (mode === "merge" || (selKind === "area" && selectedId2))) {
      e.preventDefault();
      const a = getWay(selectedId), b = getWay(selectedId2);
      if (a && b) mergeWays(a, b);
      return;
    }
    if (e.key === "Enter" && mode === "measure") { measurePts = []; measureLayer.clearLayers(); toast("Medida limpa."); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && mode === "join") {
      e.preventDefault();
      joinUndoPick();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && mode === "split") {
      e.preventDefault();
      splitUndoPick();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && (selectedId || selectedNode)) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "1") { e.preventDefault(); setSelKind("area"); }
    else if (k === "2") { e.preventDefault(); setSelKind("edge"); }
    else if (k === "3") { e.preventDefault(); setSelKind("node"); }
    else if (k === "w") { e.preventDefault(); requestMerge(); }
    else if (k === "j") setMode("join");
    else if (k === "x") setMode("split");
    else if (k === "o") { e.preventDefault(); toggleRing(getWay(selectedId)); }
    else if (k === "z") { e.preventDefault(); zoomSelection(); }
    else if (k === "v") { setMode("select"); setSelKind(selKind); }
    else if (k === "i") setMode("insert");
    else if (k === "f") setMode("draw", "flat");
    else if (k === "p") setMode("draw", "ramp");
    else if (k === "a") setMode("draw", "water");
    else if (k === "c") setMode("draw", "waterway");
    else if (k === "u") setMode("draw", "dummy");
    else if (k === "r") setMode("rect", drawKind);
    else if (k === "m") setMode("measure");
    else if (k === "h") setMode("elev");
    else if (k === "g") {
      snapOn = !snapOn;
      $("chkSnap").checked = snapOn;
      setModeLabel();
      if (mode === "draw" || mode === "rect") showSnapTargets();
    } else if (k === "?") $("help").showModal();
    else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 1;
      const lat0 = map.getCenter().lat;
      const dlat = step / 111320;
      const dlon = step / (111320 * Math.cos(lat0 * Math.PI / 180));
      if (e.key === "ArrowUp") nudge(dlat, 0);
      if (e.key === "ArrowDown") nudge(-dlat, 0);
      if (e.key === "ArrowLeft") nudge(0, -dlon);
      if (e.key === "ArrowRight") nudge(0, dlon);
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.code === "Space") spaceDown = false;
  });

  document.querySelectorAll("button[data-mode]").forEach((b) => {
    b.onclick = () => setMode(b.getAttribute("data-mode"), b.getAttribute("data-kind") || drawKind);
  });
  document.querySelectorAll("[data-sel]").forEach((b) => {
    b.onclick = () => setSelKind(b.getAttribute("data-sel"));
  });
  document.querySelectorAll("[data-vis]").forEach((el) => {
    el.onchange = () => {
      vis[el.getAttribute("data-vis")] = el.checked;
      if (el.getAttribute("data-vis") === "flat") vis.abs = el.checked;
      draw({ fit: false });
    };
  });
  $("search").oninput = () => renderLegend(lastAlts, ($("search").value || "").toLowerCase());
  $("op").oninput = () => {
    const fillOp = $("op").value / 100;
    ways.forEach((way) => {
      if (!way._layer || !way._layer.setStyle) return;
      const isLine = !way.closed || LINE_KINDS[way.kind];
      const isRamp = way.kind === "ramp";
      way._layer.setStyle({
        fillOpacity: (!isLine && way.closed) ? (isRamp ? fillOp * 0.65 : fillOp) : 0
      });
    });
  };
  $("edKind").onchange = syncKindFields;
  ["edAlt", "edHi", "edLo", "edRel", "edShift", "edCell"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => { if (selectedId) markDirty(); });
    el.addEventListener("change", () => { if (selectedId) applyTags({ silent: true }); });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !selectedId) return;
      e.preventDefault();
      e.stopPropagation();
      applyTags();
      saveOsm(false);
    });
  });
  $("btnApply").onclick = applyTags;
  $("btnNdApply").onclick = applyNode;
  $("btnNdDel").onclick = () => { if (selectedNode) deleteVertex(selectedNode, getWay(selectedId)); };
  $("btnDel").onclick = deleteSelected;
  $("btnRev").onclick = () => { const w = getWay(selectedId); if (w) reverseWay(w); };
  $("btnRot").onclick = () => { const w = getWay(selectedId); if (w) rotateWay(w); };
  $("btnDup").onclick = () => { const w = getWay(selectedId); if (w) duplicateWay(w); };
  $("btnClose").onclick = () => { const w = getWay(selectedId); if (w) toggleRing(w); };
  $("btnRing") && ($("btnRing").onclick = () => toggleRing(getWay(selectedId)));
  $("btnMerge") && ($("btnMerge").onclick = requestMerge);
  $("btnMergeInsp") && ($("btnMergeInsp").onclick = requestMerge);
  $("btnDens").onclick = () => { const w = getWay(selectedId); if (w) densifyWay(w); };
  $("btnSimp").onclick = () => { const w = getWay(selectedId); if (w) simplifyWay(w); };
  $("btnBridge").onclick = bridgeRamps;
  $("btnJoinGo") && ($("btnJoinGo").onclick = commitJoin);
  $("btnJoinClear") && ($("btnJoinClear").onclick = () => { clearJoin(); toast("Picks limpos."); });
  $("btnSplitGo") && ($("btnSplitGo").onclick = commitSplit);
  $("btnSplitClear") && ($("btnSplitClear").onclick = () => { clearSplit(); toast("Picks limpos."); });
  $("btnOrtho") && ($("btnOrtho").onclick = () => { const w = getWay(selectedId); if (w) orthogonalize(w); });
  $("btnAlignH") && ($("btnAlignH").onclick = () => { const w = getWay(selectedId); if (w) alignWay(w, "h"); });
  $("btnAlignV") && ($("btnAlignV").onclick = () => { const w = getWay(selectedId); if (w) alignWay(w, "v"); });
  $("btnSplit") && ($("btnSplit").onclick = () => setMode("split"));
  $("btnCopyTags") && ($("btnCopyTags").onclick = () => {
    const w = getWay(selectedId);
    if (!w) return;
    tagClip = Object.assign({}, w.tags);
    toast("Tags copiadas (" + Object.keys(tagClip).length + ").", "ok");
  });
  $("btnPasteTags") && ($("btnPasteTags").onclick = () => {
    const w = getWay(selectedId);
    if (!w || !tagClip) { toast("Nada na área de transferência de tags.", "warn"); return; }
    pushUndo();
    w.tags = Object.assign({}, w.tags, tagClip);
    enrich(w);
    markDirty();
    draw({ fit: false });
    selectWay(w.id);
    toast("Tags coladas.", "ok");
  });
  $("btnAbs") && ($("btnAbs").onclick = () => {
    const w = getWay(selectedId);
    if (!w || w.alt == null) return;
    $("edKind").value = "abs";
    $("edAlt").value = w.alt;
    syncKindFields();
    applyTags();
    toast("Convertido para cst_alt_abs.", "ok");
  });
  $("btnZoomSel") && ($("btnZoomSel").onclick = zoomSelection);
  $("btnLabels") && ($("btnLabels").onclick = () => {
    showLabels = !showLabels;
    $("btnLabels").classList.toggle("active", showLabels);
    if ($("chkLabels")) $("chkLabels").checked = showLabels;
    draw({ fit: false });
  });
  $("chkLabels") && ($("chkLabels").onchange = (e) => {
    showLabels = e.target.checked;
    if ($("btnLabels")) $("btnLabels").classList.toggle("active", showLabels);
    draw({ fit: false });
  });
  $("chkSnap").onchange = (e) => {
    snapOn = e.target.checked;
    setModeLabel();
    if (mode === "draw" || mode === "rect") showSnapTargets();
    else snapLayer.clearLayers();
  };
  $("btnAddTag").onclick = () => {
    addTagRow($("newK").value, $("newV").value);
    $("newK").value = "";
    $("newV").value = "";
  };
  $("btnElevFill").onclick = () => {
    const way = getWay(selectedId);
    if (!way) return;
    const c = centroid(way.latlngs);
    toast("Consultando DEM…");
    sampleElev(c[0], c[1]).then((h) => {
      if (h == null) { toast("DEM sem valor."); return; }
      $("edAlt").value = h.toFixed(1);
      $("edHi").value = h.toFixed(1);
      toast("DEM " + h.toFixed(1) + " m no centro. Aplique as tags.");
    }).catch(() => toast("Falha no DEM."));
  };
  $("btnSave").onclick = () => saveOsm(false);
  $("btnDl").onclick = () => saveOsm(true);
  $("btnUndo").onclick = undo;
  $("btnRedo").onclick = redo;
  $("btnLive").onclick = () => { if (liveOn) stopLive(); else { startLive(); load(true); } };
  $("btnSat").onclick = (e) => setBase(sat, e.currentTarget);
  $("btnOsm").onclick = (e) => setBase(osm, e.currentTarget);
  $("btnTopo").onclick = (e) => setBase(topo, e.currentTarget);
  $("btnFit").onclick = () => { if (overlay.getLayers().length) map.fitBounds(overlay.getBounds().pad(0.08)); };
  $("btnTile").onclick = () => {
    if (!tileRect) makeTileRect();
    if (map.hasLayer(tileRect)) {
      map.removeLayer(tileRect);
      $("btnTile").classList.remove("active");
    } else {
      tileRect.addTo(map);
      map.fitBounds(tileRect.getBounds());
      $("btnTile").classList.add("active");
    }
  };
  $("btnRef").onclick = loadRef;
  $("btnHelp").onclick = () => $("help").showModal();
  $("btnHelpClose").onclick = () => $("help").close();

  function ingestOpenedText(text, opts) {
    opts = opts || {};
    lastXml = "";
    if (opts.path) OSM_FILE = opts.path;
    if (opts.abs != null) OSM_ABS = opts.abs;
    if ("handle" in opts) diskHandle = opts.handle;
    undoStack = [];
    redoStack = [];
    parseOsm(text, { fit: true });
    if (opts.dirty) {
      dirty = true;
      if ($("fileLabel")) $("fileLabel").textContent = fileBase() + " *";
    }
  }
  function openFromDisk() {
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker({
        types: [{ description: "OSM patch", accept: { "application/xml": [".osm", ".xml"] } }],
        multiple: false
      }).then((handles) => {
        const handle = handles[0];
        return handle.getFile().then((file) => file.text().then((text) => {
          ingestOpenedText(text, { path: file.name, abs: file.name, handle: handle });
          toast("Aberto " + file.name + ". Ctrl+S grava neste mesmo arquivo.");
        }));
      }).catch((err) => {
        if (err && err.name === "AbortError") return;
        $("file").click();
      });
      return;
    }
    $("file").click();
  }
  if ($("btnOpen")) $("btnOpen").onclick = openFromDisk;
  $("file").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      ingestOpenedText(t, { dirty: true, handle: null });
      toast("Importado " + f.name + ". Ctrl+S grava em " + (OSM_ABS || OSM_FILE) + ".");
    });
    e.target.value = "";
  };
  $("fileSel").onchange = () => {
    if (dirty && !confirm("Há alterações não salvas. Trocar de arquivo?")) {
      $("fileSel").value = OSM_FILE;
      return;
    }
    diskHandle = null;
    OSM_FILE = $("fileSel").value;
    const opt = $("fileSel").selectedOptions[0];
    OSM_ABS = (opt && opt.dataset.abs) || "";
    if (opt && opt.dataset.lat) TILE = { lat: Number(opt.dataset.lat), lon: Number(opt.dataset.lon) };
    didFit = false;
    undoStack = [];
    redoStack = [];
    dirty = false;
    makeTileRect();
    load();
  };

  document.body.addEventListener("dragover", (e) => e.preventDefault());
  document.body.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    diskHandle = null;
    f.text().then((t) => {
      ingestOpenedText(t, { dirty: true, handle: null });
      toast("Importado " + f.name + ". Ctrl+S grava em " + (OSM_ABS || OSM_FILE) + ".");
    });
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  map.on("zoomend", setModeLabel);
  map.on("moveend", () => { if ($("zoomLabel")) $("zoomLabel").textContent = "z" + map.getZoom(); });

  function fillFileSel(files, current) {
    const sel = $("fileSel");
    sel.innerHTML = "";
    const groups = {};
    (files || []).forEach((f) => {
      const path = typeof f === "string" ? f : f.path;
      const rec = typeof f === "string" ? { path: f, name: f, abs: "", tile: TILE, tile_label: "" } : f;
      const g = rec.tile_label || "Patches";
      (groups[g] || (groups[g] = [])).push(Object.assign({ path: path }, rec));
    });
    Object.keys(groups).forEach((g) => {
      const og = document.createElement("optgroup");
      og.label = g;
      groups[g].forEach((f) => {
        const o = document.createElement("option");
        o.value = f.path;
        o.textContent = f.name || f.path;
        if (f.abs) o.dataset.abs = f.abs;
        if (f.tile) {
          o.dataset.lat = String(f.tile.lat);
          o.dataset.lon = String(f.tile.lon);
        }
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (current) sel.value = current;
  }

  syncKindFields();
  syncSelButtons();
  fetch("/api/meta")
    .then((r) => r.json())
    .then((meta) => {
      const files = meta.files || [];
      OSM_FILE = meta.default || OSM_FILE;
      const picked = files.find((f) => (f.path || f) === OSM_FILE);
      applyOpenedFile(picked || OSM_FILE);
      TILE = (picked && picked.tile) || meta.tile || TILE;
      fillFileSel(files, OSM_FILE);
      if (meta.using_app_folder) {
        toast("Pasta Patches do OrthoForge não encontrada. Gravando na pasta do editor.", "warn");
      }
      makeTileRect();
      load();
      setTimeout(() => map.invalidateSize(), 80);
      window.addEventListener("osm-refresh", () => {
        fetch("/api/meta", { cache: "no-store" }).then((r) => r.json()).then((again) => {
          fillFileSel(again.files || [], OSM_FILE);
        });
      });
    })
    .catch(() => {
      makeTileRect();
      load();
    });
})();
