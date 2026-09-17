# Navegação Marítima Inteligente com Algoritmo A*

Sistema de planejamento de rotas marítimas de custo mínimo baseado no algoritmo A*, utilizando dados reais de correntes oceânicas do **Copernicus Marine Service**.

<<<<<<< HEAD
> Trabalho prático da disciplina de **Inteligência Artificial I**  
> FHO – Fundação Hermínio Ometto | Engenharia da Computação | 2026  
> **Autores:** Moisés H. C. da Silva (RA 114518) · Felipe Apolinário de Souza (RA 114771) · Gabriel V. Krebski (RA 115442)
=======
> Trabalho prático 
> FHO – Fundação Hermínio Ometto | Engenharia da Computação | 2026  
> **Alunos:** Moisés H. C. da Silva (RA 114518) · Felipe Apolinário de Souza (RA 114771) · Gabriel V. Krebski (RA 115442)
>>>>>>> ef85ffc4c58ee8eb4ef200b04ffbc0ec51d164a5

---

## Sobre o Projeto

O sistema calcula rotas marítimas eficientes considerando as correntes oceânicas locais. Navegar em linha reta ignorando o campo vetorial de correntes resulta em maior consumo de combustível e maior tempo de travessia. O algoritmo A* adaptado encontra o caminho de custo mínimo levando em conta a velocidade efetiva da embarcação em relação à corrente local.

**Aplicações implementadas:**
- Navegação costeira otimizada para menor consumo de combustível
- Interceptação de poluentes em deriva (manchas de óleo)

---

## Estrutura do Projeto

```
projeto_oceano_ia/
├── index.html                  ← mapa interativo (abrir no navegador)
├── script.js                   ← algoritmo A*, física, renderização
├── style.css                   ← estilo da interface
├── ocean-data.js               ← dados de correntes (gerado pelo fetch_ocean.py)
├── world-land.js               ← máscara de terra (GeoJSON compactado)
├── world-countries.js          ← fronteiras e nomes dos países (GeoJSON compactado)
├── fetch_ocean.py              ← baixa dados do Copernicus e gera ocean-data.js
├── converter_dados.py          ← converte NetCDF para o formato do mapa
├── servidor.py                 ← servidor local com botão de atualização
├── servidor.bat                ← atalho Windows para iniciar o servidor
├── atualizar_correntes_GLOBAL.bat  ← atualiza correntes globais (NOAA)
├── usar_dados_REGIONAL.bat     ← usa dados regionais baixados
<<<<<<< HEAD
└── web/                        ← versão alternativa com pipeline Monte Carlo
    ├── index.html
    ├── dados.js
    ├── rota.geojson
    └── world-land.js
=======

>>>>>>> ef85ffc4c58ee8eb4ef200b04ffbc0ec51d164a5
```

---

## Como Usar

### Opção 1 — Abrir direto (sem servidor)

Dê duplo clique no `index.html`. Os dados de correntes já estão embutidos no `ocean-data.js` e o mapa funciona imediatamente, sem instalar nada.

### Opção 2 — Com servidor local (recomendado)

O servidor permite atualizar as correntes com um clique no próprio mapa.

```bash
python servidor.py
```

Acesse `http://localhost:8000` no navegador.

---

## Atualizar os Dados de Correntes

Os dados de correntes são baixados do Copernicus Marine Service. Para atualizar:

**Pré-requisito (apenas uma vez):**
```bash
pip install copernicusmarine
copernicusmarine login   # conta gratuita em marine.copernicus.eu
```

**Baixar dados globais (NOAA — sem login):**
```bash
python fetch_ocean.py
```

**Baixar dados do Copernicus (mais precisos):**
```bash
python fetch_ocean.py --source copernicus
```

Isso gera um novo `ocean-data.js` com os dados atualizados. Recarregue o mapa no navegador.

---

## Como Funciona o Algoritmo

### Dados utilizados

- **Produto:** `GLOBAL_ANALYSISFORECAST_PHY_001_024` do Copernicus Marine Service
- **Dataset:** `cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m`
- **Variáveis:** `uo` (Leste-Oeste) e `vo` (Norte-Sul) em m/s
- **Resolução:** 1/12° ≈ 9 km | Profundidade: ~0,49 m | Atualização: diária

### Modelagem em grafo

A área oceânica é discretizada em uma grade regular. Cada célula navegável é um nó do grafo. Células com terra (NaN nos dados de corrente) são bloqueadas automaticamente.

- Conectividade de **8 vizinhos** (4 cardinais + 4 diagonais)
- Arestas diagonais só são criadas se ambos os vizinhos ortogonais intermediários forem navegáveis (evita "cortar" costas e ilhas)

### Função de custo

A velocidade efetiva da embarcação sobre o fundo é calculada decompondo a corrente em componente **paralela** e **perpendicular** ao rumo:

```
v_efetiva = sqrt(v_navio² - c_perp²) + c_paralela
```

O custo de cada aresta é o **tempo de travessia** em horas:

```
g(n) = d / v_efetiva
```

Se a corrente transversal for maior que a propulsão, a aresta é descartada.

### Heurística

Distância de **Haversine** até o destino dividida pela velocidade máxima possível. É admissível — nunca superestima — garantindo optimalidade da solução.

### Implementação

- **Min-heap** (HeapQ): O(log n) por operação
- **Suavização de Chaikin** (3 iterações): reduz artefatos de grade no caminho final
- Limite de 600.000 expansões: garante resposta em **menos de 2 segundos**

---

## Interface

| Ação | Como fazer |
|---|---|
| Definir origem | Clique no mapa (ponto A) |
| Definir destino | Clique novamente (ponto B) |
| Calcular rota | Automático após definir os dois pontos |
| Ajustar velocidade | Slider de 5 a 40 nós |
| Ativar/desativar correntes animadas | Toggle no painel |
| Ativar/desativar grade | Toggle no painel |
| Atualizar correntes | Botão no painel (requer servidor ativo) |

---

## Resultados

### Caso I — Navegação costeira

| Métrica | Rota Direta | Rota A* |
|---|---|---|
| Distância | 83,8 km | 91,2 km |
| Tempo estimado | 2,5 h | 2,2 h |
| Resistência da corrente | Alta (> 0,4 m/s) | Baixa (< 0,15 m/s) |
| Consumo estimado | Elevado | Reduzido |

### Caso II — Interceptação de poluente

| Métrica | Rota Direta | Rota A* |
|---|---|---|
| Distância | 97,3 km | 89,4 km |
| Tempo estimado | 2,9 h | 2,4 h |
| Redução de tempo | — | −17,2% |
| Distância final ao alvo | 12,7 km | 2,7 km |

---

## Trabalho Futuro

O sistema atual trata o destino como ponto fixo. Em interceptação real de poluentes, o alvo está em movimento e sua posição é incerta.

A extensão planejada integra **Monte Carlo Tree Search (MCTS)** em duas camadas:

1. **Estimação:** simulação de deriva por partículas + DBSCAN para identificar o núcleo denso da mancha
2. **Planejamento:** MCTS com horizonte retrátil para interceptação sob incerteza

O A* desenvolvido aqui será reutilizado como planejador determinístico nos *rollouts* do MCTS.

---

## Referências

- HART, P. E. et al. *A formal basis for the heuristic determination of minimum cost paths.* IEEE Trans. Systems Science and Cybernetics, 1968.
- LaVALLE, S. M. et al. *A Survey of Autonomous Vehicle Behaviors: Trajectory Planning Algorithms.* PMC/NCBI, 2024.
- MANDZIUK, J. *Monte Carlo Tree Search: a review of recent modifications and applications.* arXiv:2103.04931, 2022.
- BROWNE, C. et al. *A Survey of Monte Carlo Tree Search Methods.* IEEE TCIAIG, 2012.
- IMO. *Fourth IMO GHG Study 2020.* International Maritime Organization, 2020.
- ITOPF. *Oil Spill Stats: Historical Trends and Analysis.* 2022.
- UNEP. *From Pollution to Solution.* 2021.
