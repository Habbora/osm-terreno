# OsmTerreno

Pós-processamento do relevo. A foto do chão continua a do cenário. O OsmTerreno só muda a altura dos triângulos, para o aeroporto e o entorno ficarem na altitude que você desenhou.

Foi testado no X-Plane 12. No X-Plane 11 não foi testado.

Serve para o DSF que já está no disco:

- photo ortho do X-Plane Map Enhancement
- photo ortho do Ortho4XP
- relevo baixado à parte
- malha original do X-Plane, apontando a pasta desse cenário

Se a pasta escolhida tiver `XPME_South_America`, esses são os tiles compilados.

## OSM e DSF

O **OSM** é o desenho. São polígonos no mapa, cada um com uma altitude em metros. Um polígono plano é uma área inteira na mesma altura. Uma rampa sobe de uma borda até a outra. O arquivo fica em `osm/` e termina em `.patch.osm`.

O **DSF** é o terreno do X-Plane. É a malha de triângulos que o simulador desenha naquele grau de latitude e longitude. O OsmTerreno lê esse arquivo, corta os triângulos no contorno do OSM e grava a altitude nos vértices. A foto do ortho não entra nesse arquivo.

A janela reúne a lista de OSM, a compilação, a recuperação do backup e o editor. O editor abre numa janela do próprio programa, com mapa, e só grava o arquivo. A compilação fica na janela principal.

## O que precisa

- Windows, Linux ou Mac
- Python 3.12
- 7-Zip no Linux e no Mac. No Windows ele já vem em `ferramentas/win`
- O DSFTool 24-5, já em `ferramentas/win`, `ferramentas/lin` e `ferramentas/mac`

```
py -3.12 -m pip install -r requirements.txt
```

## Abrir

No Windows, dê dois cliques em `OsmTerreno.bat`. No Linux ou no Mac:

```
sh OsmTerreno.sh
```

Na primeira vez, use **Pasta...** e aponte para o cenário. No Map Enhancement é a pasta que contém `XPME_South_America`. No Ortho4XP ou na malha original, é a pasta daquele pacote. Esse caminho fica no `config.json`, só nesta máquina.

## Tutorial

1. Coloque os `.patch.osm` em `osm/`, ou use **Importar**. **Novo** cria um arquivo vazio.
2. Clique num OSM para selecionar. Ctrl seleciona vários e Shift seleciona um intervalo. **Selecionar tudo** e **Desmarcar tudo** valem para a lista inteira.
3. **Editar** abre o mapa do OSM selecionado. O satélite é só referência para desenhar. A altitude de cada polígono aparece na lista e no mapa. Salve com Ctrl+S. Compilar não fica nessa janela.

![Editor do OSM, com os polígonos de SBSP por cima da foto](docs/editor.png)

4. **Ver malha** mostra os triângulos do DSF na área do OSM, sem gravar nada. A segunda vez abre do cache, sem ler o DSF de novo. **Atual** é o arquivo do cenário, **Original** é o backup e **Gerar prévia** corta com a faixa e as opções que estão marcadas na janela, sem gravar o DSF. A linha vermelha é o polígono plano. A laranja é uma rampa. Verde é mais baixo, amarelo e laranja são mais altos. A roda aproxima, arrastar move, e o botão direito copia a coordenada.

![Triângulos do DSF e o contorno do OSM](docs/malha.png)
5. Ajuste a **Faixa ao redor**, em metros. **Otimizar malha** junta os triângulos planos. **Melhorar triângulos** reduz ângulos muito fechados. As duas são opcionais.
6. **Compilar** grava o DSF por cima do Map Enhancement. O backup `.antes_osm` é criado uma vez e não é substituído. **Recuperar** devolve esse backup.
7. Reinicie o X-Plane para ver o terreno. O registro da última compilação fica em `logs/Log.txt`.

![Janela do OsmTerreno](docs/janela.png)

OSM do mesmo tile compilam juntos, a partir do backup. Um OSM não apaga o corte do outro. Vários tiles seguem um depois do outro.

## O que o corte faz

- Dentro do polígono, a altitude é a do OSM, mesmo abaixo do nível do mar.
- Na faixa ao redor, a altura desce lisa até o terreno.
- A malha no nível do mar, fora dos polígonos, não é reescrita. Isso evita o corte seco na água.
- O ponto na fronteira com um triângulo que não foi cortado fica na altura original, para não abrir fresta.
- O DSF volta compactado em 7z LZMA. LZMA2 faz o X-Plane recusar o arquivo.

O resumo dos manuais do DSFTool e do DDSTool está em `ferramentas/MANUAL.md`.
