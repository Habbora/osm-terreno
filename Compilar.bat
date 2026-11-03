@echo off
cd /d "%~dp0"
py -3.12 -c "import importlib.util, pathlib; p=pathlib.Path(r'%~dp0compilador\aplicar_terreno.pyw'); s=importlib.util.spec_from_file_location('t', p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); pasta=r'D:\SteamLibrary\steamapps\common\X-Plane 12\XPlane Map Enhancement Data'; arquivos=sorted(pathlib.Path(r'%~dp0osm').glob('*.osm'));
print('arquivos', len(arquivos));
[m.aplicar(pasta, str(osm), print) for osm in arquivos]"
if errorlevel 1 pause
