"""Gera fish-hotspots-data.js: a previsao global de cardumes ja calculada, para o mapa
funcionar sem o servidor Python (index.html aberto direto ou GitHub Pages).
Rode de novo depois de atualizar os dados de correntes:   python gerar_cardumes.py"""
import json
from pathlib import Path

import ai_agent

ROOT = Path(__file__).resolve().parent
data = ai_agent.generate_global_fish_hotspots()
out = ROOT / "fish-hotspots-data.js"
out.write_text("// gerado por gerar_cardumes.py - nao editar a mao\nwindow.FISH_HOTSPOTS_DATA = "
               + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
print(f"{len(data['hotspots'])} focos salvos em {out.name}")
