(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let timer = null;

  function marcados() {
    return [...document.querySelectorAll("#osmChecks input:checked")].map((el) => el.value);
  }

  function desenhar(arquivos) {
    const box = $("osmChecks");
    const antes = new Set(marcados());
    box.innerHTML = "";
    (arquivos || []).forEach((nome) => {
      const linha = document.createElement("div");
      linha.className = "osm-linha";
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = nome;
      input.checked = antes.has(nome);
      label.appendChild(input);
      const abrir = document.createElement("button");
      abrir.type = "button";
      abrir.textContent = nome;
      abrir.onclick = () => {
        const sel = $("fileSel");
        if (!sel) return;
        sel.value = nome;
        sel.dispatchEvent(new Event("change"));
      };
      linha.appendChild(label);
      linha.appendChild(abrir);
      box.appendChild(linha);
    });
  }

  function atualizar(data) {
    if (!data) return;
    if (document.activeElement !== $("pastaTerreno")) $("pastaTerreno").value = data.pasta || "";
    desenhar(data.arquivos || []);
    $("logTerreno").textContent = (data.log || []).join("\n");
    if (data.running && !timer) timer = setInterval(ler, 1000);
    if (!data.running && timer) { clearInterval(timer); timer = null; }
  }

  function ler() {
    return fetch("/api/projeto", { cache: "no-store" }).then((r) => r.json()).then(atualizar);
  }

  function post(payload) {
    return fetch("/api/projeto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((r) => r.json()).then((data) => { atualizar(data); return data; });
  }

  $("btnPasta").onclick = () => post({ pasta: $("pastaTerreno").value });
  $("pastaTerreno").onchange = () => post({ pasta: $("pastaTerreno").value });
  $("btnMarcar").onclick = () => document.querySelectorAll("#osmChecks input").forEach((el) => { el.checked = true; });
  $("btnDesmarcar").onclick = () => document.querySelectorAll("#osmChecks input").forEach((el) => { el.checked = false; });
  $("btnImportar").onclick = () => $("fileImport").click();
  $("fileImport").onchange = () => {
    const files = [...$("fileImport").files];
    $("fileImport").value = "";
    let seq = Promise.resolve();
    files.forEach((file) => {
      seq = seq.then(() => file.arrayBuffer()).then((buf) => fetch("/api/import?name=" + encodeURIComponent(file.name), {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: buf
      }));
    });
    seq.then(() => fetch("/api/meta", { cache: "no-store" }).then((r) => r.json())).then((meta) => {
      if (window.dispatchEvent) window.dispatchEvent(new CustomEvent("osm-refresh", { detail: meta }));
    }).then(ler);
  };
  $("btnExportar").onclick = () => marcados().forEach((nome) => {
    const a = document.createElement("a");
    a.href = "/api/export?name=" + encodeURIComponent(nome);
    a.download = nome;
    a.click();
  });
  $("btnApagarOsm").onclick = () => {
    const nomes = marcados();
    if (!nomes.length || !confirm("Apagar " + nomes.join(", ") + "?")) return;
    post({ acao: "apagar", nomes: nomes }).then(() => location.reload());
  };
  $("btnCompilar").onclick = () => post({ acao: "compilar", nomes: marcados() }).then(ler);
  $("btnRecuperar").onclick = () => {
    const nomes = marcados();
    if (!nomes.length || !confirm("Recuperar o backup dos tiles de " + nomes.join(", ") + "?")) return;
    post({ acao: "recuperar", nomes: nomes }).then(ler);
  };
  ler();
})();
