# Ferramentas do X-Plane no OsmTerreno

Resumo dos manuais do **X-Plane Scenery Tools 24-5** (Laminar Research), com o que importa para este projeto.
Os READMEs originais, em inglês, estão em `ferramentas/<sistema>/README.*`.

## Onde está cada ferramenta

| Sistema | DSFTool | DDSTool | Interface |
|---|---|---|---|
| Windows | `ferramentas/win/tools/DSFTool.exe` | `ferramentas/win/tools/DDSTool.exe` | `XGrinder.exe`, `Objview.exe` |
| Linux | `ferramentas/lin/tools/DSFTool` | `ferramentas/lin/tools/DDSTool` | `XGrinder`, `ObjView` |
| Mac | `ferramentas/mac/tools/DSFTool` | `ferramentas/mac/tools/DDSTool` | `XGrinder.app`, `ObjView.app` |

Versões: DSFTool 2.4.0-b1 e DDSTool 1.4.0-b1 (maio de 2024).
A licença é MIT/X11 para o código da Laminar. Fonte: http://dev.x-plane.com/cgit/cgit.cgi/xptools.git/
No Linux e no Mac, depois de copiar, é preciso marcar como executável (`chmod +x`).

O compilador usa só o DSFTool. O caminho está em `dsf_tool()` em `compilador/aplicar_terreno.pyw`.

---

## DSFTool

Converte DSF (binário do X-Plane) em texto e volta.

```
DSFTool --dsf2text <entrada.dsf> [<outra.dsf>] <saida.txt>
DSFTool --text2dsf <entrada.txt> <saida.dsf>
DSFTool --version
```

- Use `-` no lugar do arquivo de texto para ler ou escrever pela entrada e saída padrão. A saída em DSF não aceita pipe.
- O código de saída indica se a conversão deu certo. Ao gerar DSF, o status vai para stdout e os erros para stderr. Ao gerar texto, todas as mensagens vão para stderr.
- Desde a 2.2, ele lê DSF compactado em 7z direto. Para gravar, ele só gera o DSF sem compactar: a compactação é com a gente.
- É lento: a volta para DSF pode levar minutos num tile cheio.
- Cuidado com fim de linha: arquivo de texto com quebra de linha estragada pode fazer o DSFTool travar.
- Junto com o texto, ele grava a grade de elevação em `<saida.txt>.elevation.raw` (int16 little-endian, quadrada).

### Formato do texto

O cabeçalho é `A`, `800` e `DSF2TEXT`. Cada linha é um comando. Linhas com palavra desconhecida são ignoradas, e `#` serve de comentário.

| Comando | O que faz |
|---|---|
| `DIVISIONS <n>` | Quantidade de "pools" de pontos. O padrão é 8, o que dá ~20 cm de resolução lateral (2^-19 grau). Desde a 2.3, o dsf2text detecta sozinho. |
| `HEIGHTS <escala> <mínimo>` | Escala e deslocamento da altura nos pools de `PATCH_VERTEX`. O padrão é `1.0 -32768`, ou seja, **1 m de resolução vertical**. Na 2.4 é detectado sozinho para overlays. |
| `PROPERTY <nome> <valor>` | Propriedades do cabeçalho. `sim/west`, `sim/south`, `sim/east` e `sim/north` precisam vir **por último**, depois de DIVISIONS, HEIGHTS e das outras PROPERTY. |
| `TERRAIN_DEF`, `OBJECT_DEF`, `POLYGON_DEF`, `NETWORK_DEF`, `RASTER_DEF` | Definem os recursos. A ordem define o índice (o primeiro é 0). |
| `BEGIN_PATCH <terreno> <LOD perto> <LOD longe> <flags> <n coords>` | Começa um patch de malha. LOD `0 -1` é sempre visível. Flag 1 = física e colisão; flag 2 = overlay com deslocamento de Z. São no mínimo 5 coordenadas: lon, lat, altura, normal X, normal Z. |
| `BEGIN_PRIMITIVE <tipo>` | 0 = triângulos soltos, 1 = tira, 2 = leque. |
| `PATCH_VERTEX lon lat z nx nz [extras]` | Um vértice. Normal: +X é leste, +Z é sul. Os extras são coordenadas de textura e de máscara, conforme o terreno. |
| `END_PRIMITIVE`, `END_PATCH` | Fecham o primitivo e o patch. |
| `OBJECT <tipo> lon lat rot` | Objeto no chão. |
| `OBJECT_AGL ... <altura>`, `OBJECT_MSL ... <altura>` | Objeto em altura relativa ao chão ou ao nível do mar. |
| `BEGIN_SEGMENT ...`, `SHAPE_POINT ...`, `END_SEGMENT ...` | Rede viária (vetores). |
| `BEGIN_POLYGON`, `BEGIN_WINDING`, `POLYGON_POINT`, `END_WINDING`, `END_POLYGON` | Polígonos (fachadas, desenhos). |
| `RASTER_DATA version= bpp= flags= width= height= scale= offset= arquivo` | Camada raster, como a elevação. |
| `FILTER <índice>` | Mostra o conteúdo seguinte só se o aeroporto de `sim/filter/aptid` estiver ativo. |

- Triângulos soltos viram tiras sozinhos na volta para DSF, e grupos grandes são quebrados automaticamente. Pode-se escrever quantos triângulos quiser num primitivo.
- Precisão de 9 casas decimais no texto.

### Juntar dois DSF

Passando dois DSF no `--dsf2text`, o segundo tem os índices dos recursos deslocados para não colidir. Depois é só juntar as propriedades no topo. O `sim/require_obj` força o carregamento de objetos daquele índice para cima.

---

## DDSTool

Converte imagem (png, tif, jpg, bmp) em DDS para o X-Plane.

```
DDSTool <modo> [flags] <origem> <destino>
```

| Modo | Uso |
|---|---|
| `--png2dxt` | Escolhe sozinho: DXT1 sem transparência parcial, DXT5 com. |
| `--png2dxt1` | Transparência de 1 bit. Metade da memória de vídeo. |
| `--png2dxt3` | Transparência com mudança brusca. |
| `--png2dxt5` | Transparência suave. Primeira escolha quando há alfa. |
| `--png2rgb` | Sem compressão. Raramente útil. |

Mipmaps: `--std_mips` (padrão, caixa), `--pre_mips` (mipmaps já desenhados lado a lado na imagem).
Tamanho: `--scale_none` (exige potência de 2), `--scale_up`, `--scale_down`, `--scale_half`.
A gama é sempre sRGB (~2.2). A compressão usa 4 threads.

Textura sem emenda a partir de amostra: `DDSTool --quilt origem.png largura altura patch sobreposição tentativas destino.png`.

---

## XGrinder e ObjView

- **XGrinder:** janela onde se arrasta um arquivo para converter (DSF ↔ texto, imagem → DDS). Precisa da pasta `tools/` ao lado dele.
- **ObjView:** mostra objetos `.obj` do X-Plane (formatos 7 e 8). Roda do mouse dá zoom, botão esquerdo move, botão direito gira. `F` alterna arame, `M` mede, `N` modo noite, `L` iluminação.

---

## Regras que valem para o OsmTerreno

- O DSF do Map Enhancement vem compactado em 7z. Para gravar de volta, use **LZMA** (`-m0=LZMA`). Com LZMA2, o X-Plane não abre o arquivo e dá `dsf_ErrCouldNotOpenFile`. Nome que começa com `-` vai depois de `--` na linha do 7z.
- O arquivo convertido precisa começar com `XPLNEDSF`.
- O backup `<tile>.dsf.antes_osm` é a fonte de todo corte. Ele nunca é sobrescrito.
- O `--dsf2text` dos tiles do Map Enhancement traz `DIVISIONS` e `HEIGHTS` no topo, e o compilador repassa essas linhas sem mexer. Medido em novembro de 2026:

  | Tile | DIVISIONS | HEIGHTS | Faixa de altura |
  |---|---|---|---|
  | `-24-047` (SBSP) | 16 | `0.03125 -65.0` | -65 a 1982,97 m |
  | `-16-048` (SBBR) | 16 | `0.03125 0.0` | 0 a 2047,97 m |

  - A altura é gravada em degraus de **3,125 cm**. Ajuste menor que isso some, e 5 cm vira 3,1 ou 6,2 cm.
  - A altura não pode passar da faixa do tile. Em `-16-048`, nada abaixo de 0 m é gravado. Aeroporto abaixo do nível do mar depende do mínimo do `HEIGHTS` daquele tile.
  - Com 16 divisões, a precisão lateral é mais fina que os ~20 cm do padrão de 8. Mesmo assim, pontos de corte colados podem cair no mesmo lugar depois da volta para DSF.
- O mesmo ponto aparece em vários patches sobrepostos (terreno base e camadas com máscara). Mexer na altura de um ponto exige mexer igual em todos.
- Vértice de água no Map Enhancement tem altura 0. Os de terra têm altura própria.
